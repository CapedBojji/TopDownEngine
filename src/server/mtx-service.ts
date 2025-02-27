import type { OnInit } from "@flamework/core";
import { Service } from "@flamework/core";
import type { Logger } from "@rbxts/log";
import Object from "@rbxts/object-utils";
import { MarketplaceService, Players } from "@rbxts/services";
import Sift from "@rbxts/sift";
import Signal from "@rbxts/signal";

import { selectPlayerData, selectPlayerMtx } from "shared/store/persistent";
import { GamePass, Product } from "types/enum/mtx";

import type PlayerEntity from "./player/player-entity";
import type { OnPlayerJoin } from "./player/player-service";
import type PlayerService from "./player/player-service";
import { store } from "./store";

const NETWORK_RETRY_DELAY = 2;
const NETWORK_RETRY_ATTEMPTS = 10;

type ProductInfo = DeveloperProductInfo | GamePassProductInfo;

/**
 * A service for managing game passes and processing receipts.
 *
 * ```
 * this.mtxService.gamePassStatusChanged.Connect((playerEntity, gamePassId, isActive) => {
 *     if (!gamePassId === GamePasses.Example || !isActive) {
 *         return;
 *     }
 *
 *     // Do something with the game pass owned
 *     ...
 * });
 *
 * for (const pass of gamePasses) {
 *     if (this.mtxService.isGamePassActive(playerEntity, pass)) {
 *         // Do something with the game pass owned
 *         ...
 *     }
 * }
 * ```
 */
@Service({})
export default class MtxService implements OnInit, OnPlayerJoin {
	private readonly productInfoCache = new Map<number, ProductInfo>();
	private readonly purchaseIdLog = 50;

	public readonly developerProductPurchased = new Signal<
		(player: Player, productId: number) => void
	>();

	public readonly gamePassStatusChanged = new Signal<
		(player: Player, gamePassId: GamePass, isActive: boolean) => void
	>();

	constructor(
		private readonly logger: Logger,
		private readonly playerService: PlayerService,
	) {}

	/** @ignore */
	public onInit(): void {
		MarketplaceService.PromptGamePassPurchaseFinished.Connect((player, id, wasPurchased) => {
			this.onGamePassPurchaseFinished(player, tostring(id) as GamePass, wasPurchased);
		});

		MarketplaceService.ProcessReceipt = (...args): Enum.ProductPurchaseDecision => {
			const result = this.processReceipt(...args).expect();
			this.logger.Info(`ProcessReceipt result: ${result}`);
			return result;
		};
	}

	/** @ignore */
	public onPlayerJoin({ player, userId }: PlayerEntity): void {
		const gamePasses = store.getState(selectPlayerMtx(userId))?.gamePasses;
		if (gamePasses === undefined) {
			return;
		}

		const unowned = Object.values(GamePass).filter(gamePassId => !gamePasses.has(gamePassId));
		for (const gamePassId of unowned) {
			this.checkForGamePassOwned(player, gamePassId)
				.then(owned => {
					if (!owned) {
						return;
					}

					store.setGamePassOwned(userId, gamePassId);
				})
				.catch(err => {
					this.logger.Warn(`Error checking game pass ${gamePassId}: ${err}`);
				});
		}

		for (const [id, gamePassData] of gamePasses) {
			this.notifyProductActive(player, id, gamePassData.active);
		}
	}

	/**
	 * Retrieves the product information for a given product or game pass.
	 *
	 * @param infoType - The type of information to retrieve ("Product" or
	 *   "GamePass").
	 * @param productId - The ID of the product or game pass.
	 * @returns A Promise that resolves to the product information, or undefined
	 *   if the information is not available.
	 */
	public async getProductInfo(
		infoType: "GamePass" | "Product",
		productId: number,
	): Promise<ProductInfo | undefined> {
		if (this.productInfoCache.has(productId)) {
			return this.productInfoCache.get(productId);
		}

		const price = await Promise.retryWithDelay(
			async () => {
				return MarketplaceService.GetProductInfo(
					productId,
					Enum.InfoType[infoType],
				) as ProductInfo;
			},
			NETWORK_RETRY_ATTEMPTS,
			NETWORK_RETRY_DELAY,
		).catch(() => {
			this.logger.Warn(`Failed to get price for product ${productId}`);
		});

		if (price === undefined) {
			return undefined;
		}

		this.productInfoCache.set(productId, price);

		return price;
	}

	/**
	 * Checks if a game pass is active for a specific player. This method will
	 * return false if the game pass is not owned by the player.
	 *
	 * @param player - The player for whom to check the game pass.
	 * @param gamePassId - The ID of the game pass to check.
	 * @returns A boolean indicating whether the game pass is active or not.
	 */
	public isGamePassActive(player: Player, gamePassId: GamePass): boolean {
		return (
			store.getState(selectPlayerMtx(tostring(player.UserId)))?.gamePasses.get(gamePassId)
				?.active ?? false
		);
	}

	private async checkForGamePassOwned(player: Player, gamePassId: GamePass): Promise<boolean> {
		// Ensure game passId is a valid game passes for our game
		if (!Object.values(GamePass).includes(gamePassId)) {
			throw `Invalid game pass id ${gamePassId}`;
		}

		const owned = store
			.getState(selectPlayerMtx(tostring(player.UserId)))
			?.gamePasses.has(gamePassId);
		if (owned === true) {
			return true;
		}

		return MarketplaceService.UserOwnsGamePassAsync(player.UserId, tonumber(gamePassId));
	}

	private grantProduct(player: Player, productId: number, wasPurchased: boolean): void {
		if (!wasPurchased) {
			return;
		}

		// Ensure productId is a valid product for our game
		if (!Object.values(Product).includes(tostring(productId) as Product)) {
			this.logger.Warn(
				`Player ${player.Name} attempted to purchased invalid product ${productId}`,
			);
			return;
		}

		this.logger.Info(`Player ${player.Name} purchased developer product ${productId}`);

		store.purchaseDeveloperProduct(tostring(player.UserId), productId);

		this.developerProductPurchased.Fire(player, productId);
	}

	private notifyProductActive(player: Player, productId: GamePass, isActive: boolean): void {
		this.gamePassStatusChanged.Fire(player, productId, isActive);
	}

	private onGamePassPurchaseFinished(
		player: Player,
		gamePassId: GamePass,
		wasPurchased: boolean,
	): void {
		if (!wasPurchased) {
			return;
		}

		// Ensure game passId is a valid game passes for our game
		if (!Object.values(GamePass).includes(gamePassId)) {
			this.logger.Warn(
				`Player ${player.Name} attempted to purchased invalid game pass ${gamePassId}`,
			);
			return;
		}

		this.logger.Info(`Player ${player.Name} purchased game pass ${gamePassId}`);

		store.setGamePassOwned(tostring(player.UserId), gamePassId);

		this.notifyProductActive(player, gamePassId, true);
	}

	private async processReceipt(receiptInfo: ReceiptInfo): Promise<Enum.ProductPurchaseDecision> {
		this.logger.Info(
			`Processing receipt ${receiptInfo.PurchaseId} for ${receiptInfo.PlayerId}`,
		);

		const player = Players.GetPlayerByUserId(receiptInfo.PlayerId);
		if (!player) {
			return Enum.ProductPurchaseDecision.NotProcessedYet;
		}

		const playerEntity = await this.playerService.getPlayerEntityAsync(player);
		if (!playerEntity) {
			this.logger.Error(`No entity for player ${player.Name}, cannot process receipt`);
			return Enum.ProductPurchaseDecision.NotProcessedYet;
		}

		return this.purchaseIdCheck(playerEntity, receiptInfo);
	}

	private async purchaseIdCheck(
		{ document, player }: PlayerEntity,
		{ ProductId, PurchaseId }: ReceiptInfo,
	): Promise<Enum.ProductPurchaseDecision> {
		if (document.read().mtx.receiptHistory.includes(PurchaseId)) {
			const [success] = document.save().await();
			if (!success) {
				return Enum.ProductPurchaseDecision.NotProcessedYet;
			}

			return Enum.ProductPurchaseDecision.PurchaseGranted;
		}

		this.grantProduct(player, ProductId, true);

		const data = store.getState(selectPlayerData(tostring(player.UserId)));
		if (!data) {
			return Enum.ProductPurchaseDecision.NotProcessedYet;
		}

		const { receiptHistory } = data.mtx;

		const updatedReceiptHistory =
			receiptHistory.size() >= this.purchaseIdLog
				? Sift.Array.shift(receiptHistory, receiptHistory.size() - this.purchaseIdLog + 1)
				: receiptHistory;
		updatedReceiptHistory.push(PurchaseId);

		document.write(
			Sift.Dictionary.merge(data, {
				mtx: {
					receiptHistory: updatedReceiptHistory,
				},
			}),
		);

		const [success] = document.save().await();
		if (!success) {
			return Enum.ProductPurchaseDecision.NotProcessedYet;
		}

		return Enum.ProductPurchaseDecision.PurchaseGranted;
	}
}
