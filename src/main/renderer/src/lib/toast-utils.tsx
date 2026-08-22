import { toast } from "sonner"
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

// single failure toast for every download path. the stable id means repeated
// failures replace each other instead of stacking, and the long duration gives
// people time to hit Report before it fades.
export const showDownloadErrorToast = (title: string, description?: string) => {
  toast.error(title, {
    id: "download-failed",
    description,
    duration: 12000,
    action: {
      label: "Report",
      onClick: () => reportActions.open()
    }
  })
}
