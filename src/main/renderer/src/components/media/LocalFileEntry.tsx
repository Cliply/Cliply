import { FolderOpen, Loader2 } from "lucide-react"
import { Link, useNavigate } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { useT } from "@/lib/i18n"
import { localMediaActions, useLocalMedia } from "@/lib/stores/localMediaStore"
import { exportActive, useLocalExport } from "@/lib/stores/localExportStore"

export function LocalFileEntry() {
  const t = useT()
  const navigate = useNavigate()
  const busy = useLocalMedia((s) => s.busy)
  const exporting = useLocalExport(s => exportActive(s.snapshot) || s.pending)
  const source = useLocalMedia((s) => s.source)
  const error = useLocalMedia((s) => s.error)
  return <div className="mt-5 flex flex-col items-center gap-2">
    <div className="flex flex-wrap justify-center gap-2">
      <Button variant="outline" disabled={busy || exporting} onClick={async () => {
        if (await localMediaActions.open()) navigate("/media")
      }}>{busy ? <Loader2 className="animate-spin" /> : <FolderOpen />}{t(busy ? "media.opening" : "media.open")}</Button>
      {source && <Button variant="ghost" asChild><Link to="/media">{t("media.return")}</Link></Button>}
      {busy && <Button variant="ghost" onClick={() => void localMediaActions.close()}>{t("media.cancel")}</Button>}
    </div>
    {error && <p role="alert" className="max-w-xl text-center text-sm text-red-600 dark:text-red-400">{error}</p>}
  </div>
}
