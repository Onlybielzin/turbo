import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { ask } from "@tauri-apps/plugin-dialog";

/**
 * Checks GitHub Releases (via the endpoint in tauri.conf.json) for a newer
 * signed version. If one exists, asks the user whether to install now; on yes,
 * downloads + installs the update and relaunches the app.
 *
 * Best-effort: offline, no matching release, or a missing endpoint are all
 * non-fatal and simply skip the update silently.
 */
export async function checkForUpdates(): Promise<void> {
  try {
    const update = await check();
    if (!update) return;

    const notes = update.body ? `\n\n${update.body}` : "";
    const shouldInstall = await ask(
      `Turbo ${update.version} está disponível (você tem ${update.currentVersion}).${notes}\n\nInstalar agora?`,
      {
        title: "Atualização disponível",
        kind: "info",
        okLabel: "Instalar e reiniciar",
        cancelLabel: "Depois",
      },
    );
    if (!shouldInstall) return;

    await update.downloadAndInstall();
    await relaunch();
  } catch (err) {
    // Non-fatal: no internet, no matching release, endpoint unreachable, etc.
    console.error("update check failed", err);
  }
}
