use serde::Deserialize;
use serde_json::{json, Value};

/// Standard pagination query for list endpoints.
///
/// Canonical params are `?page=1&per_page=50` (1-based page). The legacy
/// `?limit=&offset=` pair stays accepted as a deprecated alias; canonical
/// params win when both are sent.
///
/// Fields are strings so the struct survives `#[serde(flatten)]` embedding
/// (serde_urlencoded cannot feed numeric leaves through a flattened map);
/// `resolve()` parses and clamps.
#[derive(Debug, Default, Deserialize, utoipa::ToSchema)]
pub struct PageQuery {
    pub page: Option<String>,     // canonical, 1-based
    pub per_page: Option<String>, // canonical
    pub limit: Option<String>,    // alias, deprecated
    pub offset: Option<String>,   // alias, deprecated
}

fn parse_i64(v: &Option<String>) -> Option<i64> {
    v.as_deref().and_then(|s| s.parse::<i64>().ok())
}

/// Fully resolved pagination state for one request.
#[derive(Debug, Clone, Copy)]
pub struct PageBounds {
    pub page: i64,
    pub per_page: i64,
    pub limit: i64,
    pub offset: i64,
}

impl PageBounds {
    /// `total_pages` for a given row count (0 rows → 0 pages).
    pub fn total_pages(&self, total: i64) -> i64 {
        if total <= 0 {
            0
        } else {
            (total + self.per_page - 1) / self.per_page
        }
    }
}

impl PageQuery {
    /// Resolve with alias precedence: `page`/`per_page` win over `limit`/`offset`;
    /// when only the aliases are sent, `page = offset / per_page + 1`.
    /// `per_page` clamps to `[1, max]` (defaulting to `default`), `page` to `>= 1`.
    /// Negative, zero, or garbage values clamp instead of erroring.
    pub fn resolve(&self, default: i64, max: i64) -> PageBounds {
        let per_page = match parse_i64(&self.per_page).or_else(|| parse_i64(&self.limit)) {
            Some(v) => v.clamp(1, max),
            None => default.clamp(1, max),
        };

        let page = match parse_i64(&self.page) {
            Some(v) => v.max(1),
            None => {
                let offset = parse_i64(&self.offset).unwrap_or(0).max(0);
                offset / per_page + 1
            }
        };

        PageBounds {
            page,
            per_page,
            limit: per_page,
            offset: (page - 1) * per_page,
        }
    }

    /// Legacy (limit, offset) pair for callers that have not migrated to
    /// `resolve` yet. Equivalent to `resolve(default, max)` projected onto
    /// the old tuple.
    pub fn bounds(&self, default: i64, max: i64) -> (i64, i64) {
        let b = self.resolve(default, max);
        (b.limit, b.offset)
    }
}

/// Build the unified list envelope `meta` object:
/// `{"total","page","per_page","total_pages","limit","offset"}`.
/// `limit`/`offset` are deprecated aliases of `per_page`/`page` kept for one
/// release; new consumers read `total`/`page`/`per_page`/`total_pages`.
pub fn page_meta_json(total: i64, bounds: &PageBounds) -> Value {
    json!({
        "total": total,
        "page": bounds.page,
        "per_page": bounds.per_page,
        "total_pages": bounds.total_pages(total),
        "limit": bounds.limit,
        "offset": bounds.offset,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolve(
        page: Option<&str>,
        per_page: Option<&str>,
        limit: Option<&str>,
        offset: Option<&str>,
    ) -> PageBounds {
        PageQuery {
            page: page.map(String::from),
            per_page: per_page.map(String::from),
            limit: limit.map(String::from),
            offset: offset.map(String::from),
        }
        .resolve(50, 200)
    }

    #[test]
    fn defaults_when_nothing_sent() {
        let b = resolve(None, None, None, None);
        assert_eq!((b.page, b.per_page, b.limit, b.offset), (1, 50, 50, 0));
    }

    #[test]
    fn canonical_params_win_over_aliases() {
        let b = resolve(Some("3"), Some("20"), Some("77"), Some("999"));
        assert_eq!((b.page, b.per_page), (3, 20));
        assert_eq!(b.offset, 40); // derived from canonical params, not the alias
    }

    #[test]
    fn aliases_still_work() {
        let b = resolve(None, None, Some("25"), Some("50"));
        assert_eq!((b.page, b.per_page), (3, 25));
        assert_eq!(b.offset, 50);
    }

    #[test]
    fn offset_without_limit_uses_default_per_page() {
        let b = resolve(None, None, None, Some("120"));
        assert_eq!((b.page, b.per_page), (3, 50));
        assert_eq!(b.offset, 100); // re-derived from page, not the raw offset
    }

    #[test]
    fn clamps_zero_negative_and_garbage() {
        let b = resolve(Some("0"), Some("0"), None, None);
        assert_eq!((b.page, b.per_page), (1, 1));

        let b = resolve(Some("-5"), Some("-3"), None, None);
        assert_eq!((b.page, b.per_page), (1, 1));

        let b = resolve(None, Some("9999"), None, None);
        assert_eq!(b.per_page, 200);

        // Garbage falls back to the default instead of erroring.
        let b = resolve(Some("abc"), Some("lots"), None, None);
        assert_eq!((b.page, b.per_page), (1, 50));
    }

    #[test]
    fn legacy_bounds_matches_resolve() {
        let q = PageQuery {
            page: None,
            per_page: None,
            limit: Some("30".into()),
            offset: Some("60".into()),
        };
        assert_eq!(q.bounds(50, 200), (30, 60));
    }

    #[test]
    fn page_beyond_last_yields_empty_page_meta() {
        let b = resolve(Some("99"), Some("50"), None, None);
        let meta = page_meta_json(120, &b);
        assert_eq!(meta["total"], 120);
        assert_eq!(meta["total_pages"], 3);
        assert_eq!(meta["page"], 99); // requested page echoed, data is empty
        assert_eq!(meta["offset"], 4900);
    }

    #[test]
    fn meta_shape_is_complete() {
        let b = resolve(Some("2"), Some("50"), None, None);
        let meta = page_meta_json(1234, &b);
        assert_eq!(meta["total"], 1234);
        assert_eq!(meta["page"], 2);
        assert_eq!(meta["per_page"], 50);
        assert_eq!(meta["total_pages"], 25);
        assert_eq!(meta["limit"], 50);
        assert_eq!(meta["offset"], 50);
    }

    #[test]
    fn zero_total_is_zero_pages() {
        let b = resolve(None, None, None, None);
        assert_eq!(b.total_pages(0), 0);
        assert_eq!(page_meta_json(0, &b)["total_pages"], 0);
    }

    #[test]
    fn deserializes_from_query_strings_via_flatten() {
        // Mirror serde_urlencoded's flatten path: every leaf arrives as a string.
        #[derive(Deserialize)]
        struct Wrapper {
            #[serde(flatten)]
            page: PageQuery,
        }
        let w: Wrapper = serde_urlencoded::from_str("page=2&per_page=30").unwrap();
        let b = w.page.resolve(50, 200);
        assert_eq!((b.page, b.per_page), (2, 30));
    }
}
