import { toast } from "sonner"
import { cookieActions } from "@/lib/cookieStore"
import { t } from "@/lib/i18n"
import { reportActions } from "@/lib/reportStore"
import type { Platform } from "@/lib/store"

export const showServerOverwhelmedToast = () => {
  toast(
    <div className="flex items-center gap-3 font-space-grotesk">
      <span className="text-lg">🌻</span>
      <span>{t("toast.overwhelmed")}</span>
    </div>
  )
}

export const showDownloadSuccessToast = (type: "audio" | "video") => {
  const audio = type === "audio"

  toast.success(t(audio ? "toast.audioDone" : "toast.videoDone"), {
    description: t(audio ? "toast.audioDoneDesc" : "toast.videoDoneDesc"),
    action: {
      label: t("toast.openFolder"),
      onClick: () => window.electronAPI?.system?.openDownloadFolder?.()
    }
  })
}

export const showFolderSelectedToast = () => {
  toast.success(t("folder.updated"))
}

/**
 * the cookie jar is youtube's, and so is the only failure it can fix
 *
 * BOT_DETECTION is not a youtube-only category: the taxonomy matches a bare
 * "use --cookies", which tiktok and pinterest emit too. Offering to fix one of
 * those with a dialog that imports youtube cookies sends the user somewhere
 * that cannot help. An unknown platform gets the report action rather than the
 * cookie one, because a missing action is better than a wrong one.
 */
const cookiesCanHelp = (platform?: Platform) => platform === "youtube"

/**
 * youtube refused us, and the user can do something about it
 *
 * kept separate from the download failure toast because the metadata fetch is
 * where a blocked install fails first - roughly three quarters of bot detection
 * lands on a lookup rather than on a download - and that path had no action on
 * its toast at all. A blocked user could read the error and had nowhere to go.
 *
 * the title is main's own wording, so the sentence the user reads is the one
 * the taxonomy wrote.
 */
export const showBotDetectionToast = (message: string, platform?: Platform) => {
  toast.error(message, {
    id: "bot-detected",
    description: cookiesCanHelp(platform)
      ? t("toast.botCookies")
      : t("toast.botGeneric"),
    duration: 12000,
    action: cookiesCanHelp(platform)
      ? { label: t("toast.fixWithCookies"), onClick: () => cookieActions.open() }
      : { label: t("toast.report"), onClick: () => reportActions.open() }
  })
}

/**
 * single failure toast for every download path. the stable id means repeated
 * failures replace each other instead of stacking, and the long duration gives
 * people time to hit the action before it fades.
 *
 * bot detection gets a different action, because it is the one failure the user
 * can actually fix. main has flagged these since long before there was anywhere
 * to send them - `needsCookies` on the error, and a `suggestion` reading "Import
 * your YouTube cookies from Settings" that no renderer has ever rendered. This
 * is the first thing to read either, and the reason the cookie jar had zero
 * imports across 1,244 users: not low adoption, but no door.
 *
 * reporting is not lost. the failure is staged with reportActions.stage() on
 * every path that reaches this toast, so the report dialog still has it.
 */
export const showDownloadErrorToast = (
  title: string,
  description?: string,
  category?: string,
  platform?: Platform
) => {
  const blocked = category === "BOT_DETECTION" && cookiesCanHelp(platform)

  toast.error(title, {
    id: "download-failed",
    description,
    duration: 12000,
    action: blocked
      ? { label: t("toast.fixWithCookies"), onClick: () => cookieActions.open() }
      : { label: t("toast.report"), onClick: () => reportActions.open() }
  })
}
