import sharp from "sharp";

const GRID_COLS = 3;
const GRID_ROWS = 3;

export type CroppedScene = {
  filename: string;
  data: Buffer;
};

/**
 * Splits one storyboard image into a 3×3 grid of equal panels (row-major: top-left → bottom-right).
 * Scene numbers start at `startSceneNumber` (1-based), zero-padded in the filename.
 */
export async function extractGridScenesFromSheet(
  imageBuffer: Buffer,
  startSceneNumber: number
): Promise<CroppedScene[]> {
  const meta = await sharp(imageBuffer).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (w < GRID_COLS || h < GRID_ROWS) {
    throw new Error(`Image too small for a ${GRID_COLS}×${GRID_ROWS} grid (${w}×${h}).`);
  }

  const panelW = Math.floor(w / GRID_COLS);
  const panelH = Math.floor(h / GRID_ROWS);
  const out: CroppedScene[] = [];
  let n = startSceneNumber;

  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      const data = await sharp(imageBuffer)
        .extract({
          left: col * panelW,
          top: row * panelH,
          width: panelW,
          height: panelH,
        })
        .png()
        .toBuffer();

      out.push({
        filename: `scene_${String(n).padStart(3, "0")}.png`,
        data,
      });
      n += 1;
    }
  }

  return out;
}
