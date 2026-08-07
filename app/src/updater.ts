import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { ask, message } from "@tauri-apps/plugin-dialog";

/**
 * Checks GitHub Releases (via the endpoint in tauri.conf.json) for a newer
 * signed version. If one exists, asks the user whether to install now; on yes,
 * downloads + installs the update and relaunches the app.
 *
 * `manual` = triggered by the toolbar "Atualizar" button: give explicit feedback
 * when already up-to-date or on error. The automatic startup check stays silent
 * (best-effort: offline, no release, or a missing endpoint simply skip).
 */
export async function checkForUpdates(manual = false): Promise<void> {
  try {
    const update = await check();
    if (!update) {
      if (manual) {
        await message("Você já está na última versão do Turbo.", {
          title: "Tudo atualizado",
          kind: "info",
        });
      }
      return;
    }

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
    if (manual) {
      await message(`Não foi possível verificar atualizações.\n\n${String(err)}`, {
        title: "Erro ao atualizar",
        kind: "error",
      });
    }
  }
}
