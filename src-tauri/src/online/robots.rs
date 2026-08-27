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
    // Consecutive `User-agent` lines introduce one group that every named agent
    // shares. Treating each line as its own group would drop the rules whenever
    // `*` is listed before another agent, and dropping a rule here means
    // crawling something the operator asked us not to.
    let mut naming_agents = false;
    let mut rules = Vec::new();
    for raw_line in robots.lines() {
        let line = raw_line.split('#').next().unwrap_or_default().trim();
        let Some((field, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        match field.trim().to_ascii_lowercase().as_str() {
            "user-agent" => {
                if !naming_agents {
                    // A new group begins; forget the previous one.
                    applies = false;
                    naming_agents = true;
                }
                applies = applies || value == "*";
            }
            "allow" | "disallow" => {
                naming_agents = false;
                if applies && !value.is_empty() {
                    rules.push((field.trim().eq_ignore_ascii_case("allow"), value.to_string()));
                }
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
    fn a_group_naming_several_agents_applies_to_all_of_them() {
        // Reading each User-agent line as its own group would drop the rule
        // whenever `*` is named first, and crawl what was asked to be left
        // alone. Both orderings must behave the same.
        let star_first = "User-agent: *\nUser-agent: BadBot\nDisallow: /private";
        let star_last = "User-agent: BadBot\nUser-agent: *\nDisallow: /private";

        assert!(!allows(star_first, "/private/x"));
        assert!(!allows(star_last, "/private/x"));
        assert!(allows(star_first, "/public/x"));
    }

    #[test]
    fn a_group_that_does_not_name_us_is_still_ignored() {
        let robots = "User-agent: Applebot\nDisallow: /\n\nUser-agent: Googlebot\nDisallow:";

        // Neither group names `*`, so nothing here restricts a generic client.
        assert!(allows(robots, "/anything"));
    }

    #[test]
    fn a_blanket_refusal_with_one_carve_out_is_honoured_both_ways() {
        // The shape spectrumcomputing.co.uk actually publishes: everything is
        // refused except one path, which the longest-match rule must find.
        let robots = "User-agent: *\nDisallow: /\nAllow: /entry/";

        assert!(!allows(robots, "/games/list"));
        assert!(allows(robots, "/entry/12345"));
    }

    #[test]
    fn comments_and_spacing_are_tolerated() {
        let robots = "  User-Agent :  *  # everyone\n  Disallow : /private # secret ";
        assert!(!allows(robots, "/private/list"));
        assert!(allows(robots, "/public/list"));
    }
}
