import { createHash } from "node:crypto";

import sharp from "sharp";

export function imageContentHash(binary: Buffer): string {
  return createHash("sha256").update(binary).digest("hex");
}

export async function imagePerceptualHash(binary: Buffer): Promise<string> {
  const pixels = await sharp(binary, { failOn: "warning" })
    .flatten({ background: "#ffffff" })
    .resize(9, 8, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer();
  let bits = "";
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const left = (y * 9 + x) * 3;
      const right = left + 3;
      const leftLuma = 299 * pixels[left]! + 587 * pixels[left + 1]! + 114 * pixels[left + 2]!;
      const rightLuma = 299 * pixels[right]! + 587 * pixels[right + 1]! + 114 * pixels[right + 2]!;
      bits += leftLuma > rightLuma ? "1" : "0";
    }
  }
  return Array.from({ length: 16 }, (_, index) => Number.parseInt(bits.slice(index * 4, index * 4 + 4), 2).toString(16)).join("");
}

export function perceptualHashDistance(left: string, right: string): number | null {
  if (!/^[0-9a-f]{16}$/iu.test(left) || !/^[0-9a-f]{16}$/iu.test(right)) return null;
  const bitCounts = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4] as const;
  let distance = 0;
  for (let index = 0; index < 16; index += 1) {
    distance += bitCounts[Number.parseInt(left[index]!, 16) ^ Number.parseInt(right[index]!, 16)]!;
  }
  return distance;
}
