import { UpdateNotification } from "@/components/ui/update-notification"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useState } from "react"
import { Toaster } from "sonner"

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000, // 1 minute
            retry: 2
          }
        }
      })
  )

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <UpdateNotification />
      <Toaster position="bottom-right" />
    </QueryClientProvider>
  )
}
