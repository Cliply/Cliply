import { motion } from "framer-motion"

import { useMediaSearch } from "@/lib/hooks/useMediaSearch"
import type { Platform } from "@/lib/stores/store"
import { URLInput } from "./URLInput"

interface SearchCardProps {
  platform: Platform
}

export function SearchCard({ platform }: SearchCardProps) {
  const { form, isLoading, onSubmit } = useMediaSearch(platform)

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="w-full max-w-4xl mx-auto px-4"
    >
      <form onSubmit={form.handleSubmit(onSubmit)} className="w-full">
        <URLInput
          form={form}
          onFocusChange={() => {}}
          isLoading={isLoading}
          platform={platform}
        />
      </form>
    </motion.div>
  )
}
