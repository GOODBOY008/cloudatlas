import { useEffect, useState } from 'react'
import { useLocation, useNavigationType, useSearchParams } from 'react-router-dom'

/** Keep keystrokes synchronous while the router updates the shareable search URL. */
export function useSearchDraft() {
  const [params, setParams] = useSearchParams()
  const query = params.get('q') ?? ''
  const [searchInput, setSearchInput] = useState(query)
  const location = useLocation()
  const navigationType = useNavigationType()

  useEffect(() => {
    // Back, Forward and links restore their own text. A completed edit can be
    // older than the draft if the user has already typed the next character.
    if (navigationType !== 'REPLACE' || !location.state?.searchDraftEdit) setSearchInput(query)
  }, [location.key, location.state, navigationType, query])

  function replaceSearch(next: URLSearchParams) {
    setSearchInput(next.get('q') ?? '')
    setParams(next, { replace: true, preventScrollReset: true, state: { searchDraftEdit: true } })
  }

  return { params, setParams, searchInput, replaceSearch }
}
