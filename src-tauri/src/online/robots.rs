//! Minimal `robots.txt` support for the website adapter.
//!
//! Only the wildcard user-agent group is read, and the longest matching rule
//! wins, which is the behaviour the major crawlers implement. When a site says
//! no, inspection stops; there is no override.

/// True when `path` may be fetched according to `robots`.
///
/// An empty or unreachable `robots.txt` allows everything, which matches the
/// standard: absence of a policy is not a prohibition.
pub fn allows(robots: &str, path: &str) -> bool {
    let mut applies = false;
    let mut rules = Vec::new();
    for raw_line in robots.lines() {
        let line = raw_line.split('#').next().unwrap_or_default().trim();
        let Some((field, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        match field.trim().to_ascii_lowercase().as_str() {
            "user-agent" => applies = value == "*",
            "allow" | "disallow" if applies && !value.is_empty() => {
                rules.push((field.trim().eq_ignore_ascii_case("allow"), value.to_string()));
            }
            _ => {}
        }
    }
    rules
        .into_iter()
        .filter(|(_, prefix)| path.starts_with(prefix.as_str()))
        .max_by_key(|(_, prefix)| prefix.len())
        .is_none_or(|(allow, _)| allow)
}

#[cfg(test)]
mod tests {
    use super::allows;

    #[test]
    fn no_policy_allows_everything() {
        assert!(allows("", "/bbc/homepage.html"));
    }

    #[test]
    fn a_wildcard_disallow_blocks_the_tree() {
        let robots = "User-agent: *\nDisallow: /";
        assert!(!allows(robots, "/games/"));
    }

    #[test]
    fn the_longest_matching_rule_wins() {
        let robots = "User-agent: *\nDisallow: /downloads\nAllow: /downloads/public";
        assert!(!allows(robots, "/downloads/private/x.zip"));
        assert!(allows(robots, "/downloads/public/x.zip"));
    }

    #[test]
    fn rules_for_other_crawlers_are_ignored() {
        let robots = "User-agent: BadBot\nDisallow: /\n\nUser-agent: *\nAllow: /";
        assert!(allows(robots, "/anything"));
    }

    #[test]
    fn comments_and_spacing_are_tolerated() {
        let robots = "  User-Agent :  *  # everyone\n  Disallow : /private # secret ";
        assert!(!allows(robots, "/private/list"));
        assert!(allows(robots, "/public/list"));
    }
}
