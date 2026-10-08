// storage.session survives service-worker suspension, but not browser restart,
// extension reload, disable/re-enable, or update. Temporary files never cross that boundary.
export async function initializeLifecycle(storage, browser) {
  const state = await browser.storage.session.get('browserRun');
  if (!state.browserRun) {
    await storage.clearTemporary();
    await browser.storage.session.set({ browserRun: crypto.randomUUID() });
  }
  await storage.reconcileTabs((await browser.tabs.query({})).map(tab => tab.id));
}
