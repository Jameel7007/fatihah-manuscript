// Capture must never certify a partial manuscript after a required asset fails.
export async function loadCaptureAssets<I, G>(
  loadInk: () => Promise<I>, loadGlyph: () => Promise<G>, wantsRelief: boolean,
): Promise<{ ink: I; glyph: G | undefined }> {
  const ink = await loadInk();
  const glyph = wantsRelief ? await loadGlyph() : undefined;
  return { ink, glyph };
}
