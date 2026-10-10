import fs from "node:fs";

/** Width/height from a PNG's IHDR chunk (bytes 16-24). */
export function pngSize(file: string): { width: number; height: number } {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(24);
    fs.readSync(fd, buf, 0, 24, 0);
    if (buf.toString("ascii", 1, 4) !== "PNG") throw new Error(`${file} is not a PNG`);
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } finally {
    fs.closeSync(fd);
  }
}
