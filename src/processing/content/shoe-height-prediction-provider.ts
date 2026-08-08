import type { JsonValue } from "../../contracts/index.js";

export type ShoeHeightClass = "low" | "mid" | "high";

export interface ShoeHeightPrediction {
  readonly predictedClass: ShoeHeightClass;
  readonly confidence?: number;
  readonly top1Index?: number;
}

export interface ShoeHeightPredictionProvider {
  readonly code: string;
  readonly version: string;
  readonly configurationFingerprint: JsonValue;
  predict(image: Buffer): Promise<ShoeHeightPrediction>;
}
