import { toast } from "sonner"

export const showServerOverwhelmedToast = () => {
  toast(
    <div className="flex items-center gap-3 font-space-grotesk">
      <span className="text-lg">🌻</span>
      <span>we&apos;re overwhelmed</span>
    </div>
  )
}

export const showServerStartingToast = () => {
  toast(
    <div className="flex items-center gap-3 font-space-grotesk">
      <div className="flex items-center justify-center w-5 h-5">
        <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin"></div>
      </div>
      <span>download engine starting...</span>
    </div>,
    {
      id: "server-starting",
      duration: 0 // Keep visible until dismissed
    }
  )
}

export const showServerReadyToast = () => {
  toast.dismiss("server-starting") // Dismiss the starting toast
  toast(
    <div className="flex items-center gap-3 font-space-grotesk">
      <span className="text-lg">✓</span>
      <span>download engine ready</span>
    </div>,
    {
      duration: 3000
    }
  )
}

export const showDownloadSuccessToast = (type: "audio" | "video") => {
  toast.success(`${type === "audio" ? "Audio" : "Video"} downloaded successfully!`, {
    description: `Your ${type} file has been downloaded to your device.`,
    action: {
      label: "Open Folder",
      onClick: () => window.electronAPI?.system?.openDownloadFolder?.()
    }
  })
}
