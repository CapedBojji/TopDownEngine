declare type Nominal = number | string | boolean;

declare type ToString<T extends Nominal> = `${T}`;
declare function tostring<T>(value: T): T extends Nominal ? ToString<T> : string;
declare function tonumber(value: ToString<number>, base?: number): number;
