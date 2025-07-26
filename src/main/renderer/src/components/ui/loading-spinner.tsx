import { cn } from "@/lib/utils"
import { Loader2 } from "lucide-react"

interface LoadingSpinnerProps extends React.HTMLAttributes<HTMLDivElement> {
  size?: number
}

export function LoadingSpinner({
  size = 24,
  className,
  ...props
}: LoadingSpinnerProps) {
  return (
    <div role="status" className={cn("animate-spin", className)} {...props}>
      <Loader2 size={size} />
      <span className="sr-only">Loading...</span>
    </div>
  )
}
