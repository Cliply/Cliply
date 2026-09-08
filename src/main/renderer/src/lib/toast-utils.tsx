import { toast } from "sonner"
import { cookieActions } from "@/lib/cookieStore"
import { reportActions } from "@/lib/reportStore"

export const showServerOverwhelmedToast = () => {
  toast(
    <div className="flex items-center gap-3 font-space-grotesk">
      <span className="text-lg">🌻</span>
      <span>we&apos;re overwhelmed</span>
    </div>
  )
}

export const showDownloadSuccessToast = (type: "audio" | "video") => {
  toast.success(
    `${type === "audio" ? "Audio" : "Video"} downloaded successfully!`,
    {
      description: `Your ${type} file has been downloaded to your device.`,
      action: {
        label: "Open Folder",
        onClick: () => window.electronAPI?.system?.openDownloadFolder?.()
      }
    }
  )
}

export const showFolderSelectedToast = () => {
  toast.success("Download folder updated!")
}

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
export const showBotDetectionToast = (message: string) => {
  toast.error(message, {
    id: "bot-detected",
    description: "Signing in with a throwaway account usually clears this.",
    duration: 12000,
    action: {
      label: "Fix with cookies",
      onClick: () => cookieActions.open()
    }
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
  category?: string
) => {
  const blocked = category === "BOT_DETECTION"

  toast.error(title, {
    id: "download-failed",
    description,
    duration: 12000,
    action: blocked
      ? { label: "Fix with cookies", onClick: () => cookieActions.open() }
      : { label: "Report", onClick: () => reportActions.open() }
  })
}
