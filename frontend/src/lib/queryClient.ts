import { QueryClient } from '@tanstack/react-query'

/** One application cache, shared by the provider and session cleanup. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
    },
  },
})
