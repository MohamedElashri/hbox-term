//! Linux cron syntax, adapted to the schedule library's Sunday=1 convention.
use chrono::{DateTime, Utc};
use cron::Schedule;
use std::{collections::BTreeSet, str::FromStr};

pub(crate) struct Entry<'a> {
    pub schedule: String,
    pub user: Option<&'a str>,
    pub command: &'a str,
}

fn word(input: &str) -> Option<(&str, &str)> {
    let input = input.trim_start();
    if input.is_empty() {
        return None;
    }
    let end = input.find(char::is_whitespace).unwrap_or(input.len());
    Some((&input[..end], input[end..].trim_start()))
}

pub(crate) fn entry(line: &str, system: bool) -> Option<Entry<'_>> {
    let line = line.trim_start();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    if let Some((name, _)) = line.split_once('=') {
        let name = name.trim();
        if !name.is_empty()
            && name.bytes().enumerate().all(|(index, c)| {
                c == b'_' || c.is_ascii_alphabetic() || index > 0 && c.is_ascii_digit()
            })
        {
            return None;
        }
    }
    let (first, mut rest) = word(line)?;
    let schedule = if first.starts_with('@') {
        first.to_string()
    } else {
        let mut fields = vec![first];
        for _ in 1..5 {
            let (field, remaining) = word(rest)?;
            fields.push(field);
            rest = remaining;
        }
        fields.join(" ")
    };
    let user = if system {
        let (user, remaining) = word(rest)?;
        rest = remaining;
        Some(user)
    } else {
        None
    };
    if rest.trim().is_empty() {
        return None;
    }
    Some(Entry {
        schedule,
        user,
        command: rest,
    })
}

pub(crate) fn metadata(line: &str) -> (&str, Option<&str>) {
    if let Some((command, id)) = line.rsplit_once(" # ternway:") {
        let id = id.trim();
        if id.starts_with("user:")
            && id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b":_-".contains(&c))
        {
            return (command, Some(id));
        }
    }
    (line, None)
}

fn invalid() -> String {
    "That Linux cron expression is not valid".into()
}

fn ordinals(
    field: &str,
    minimum: u32,
    maximum: u32,
    names: &[&str],
) -> Result<BTreeSet<u32>, String> {
    let number = |text: &str| -> Result<u32, String> {
        let value = text
            .parse()
            .ok()
            .filter(|_| text.bytes().all(|c| c.is_ascii_digit()))
            .or_else(|| {
                names
                    .iter()
                    .position(|name| name.eq_ignore_ascii_case(text))
                    .map(|i| minimum + i as u32)
            })
            .ok_or_else(invalid)?;
        if (minimum..=maximum).contains(&value) {
            Ok(value)
        } else {
            Err(invalid())
        }
    };
    let mut values = BTreeSet::new();
    for part in field.split(',') {
        let (range, step) = if let Some((range, step)) = part.split_once('/') {
            (
                range,
                step.parse::<u32>()
                    .ok()
                    .filter(|v| *v > 0 && step.bytes().all(|c| c.is_ascii_digit()))
                    .ok_or_else(invalid)?,
            )
        } else {
            (part, 1)
        };
        let (start, end) = if range == "*" {
            (minimum, maximum)
        } else if let Some((start, end)) = range.split_once('-') {
            (number(start)?, number(end)?)
        } else {
            let start = number(range)?;
            (start, if part.contains('/') { maximum } else { start })
        };
        if start > end {
            return Err(invalid());
        }
        values.extend((start..=end).filter(|value| (value - start) % step == 0));
    }
    if values.is_empty() {
        Err(invalid())
    } else {
        Ok(values)
    }
}

fn schedules(value: &str) -> Result<Option<Vec<Schedule>>, String> {
    if value.contains(['\n', '\r']) {
        return Err(invalid());
    }
    let value = match value.trim() {
        "@reboot" => return Ok(None),
        "@yearly" | "@annually" => "0 0 1 1 *",
        "@monthly" => "0 0 1 * *",
        "@weekly" => "0 0 * * 0",
        "@daily" | "@midnight" => "0 0 * * *",
        "@hourly" => "0 * * * *",
        other => other,
    };
    let fields: Vec<_> = value.split_whitespace().collect();
    if fields.len() != 5 {
        return Err(invalid());
    }
    let months = [
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ];
    let days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    let ranges = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 7)];
    let mut normalized = Vec::new();
    for (index, field) in fields.iter().enumerate() {
        let names = if index == 3 {
            &months[..]
        } else if index == 4 {
            &days[..]
        } else {
            &[]
        };
        let mut values = ordinals(field, ranges[index].0, ranges[index].1, names)?;
        if index == 4 {
            values = values.into_iter().map(|day| day % 7 + 1).collect();
        }
        normalized.push(
            values
                .into_iter()
                .map(|v| v.to_string())
                .collect::<Vec<_>>()
                .join(","),
        );
    }
    let build = |day: &str, weekday: &str| {
        Schedule::from_str(&format!(
            "0 {} {} {} {} {}",
            normalized[0], normalized[1], day, normalized[3], weekday
        ))
        .map_err(|_| invalid())
    };
    // Linux cron uses OR when both day fields are restricted; the library uses AND.
    let schedules = if !fields[2].contains('*') && !fields[4].contains('*') {
        vec![build(&normalized[2], "*")?, build("*", &normalized[4])?]
    } else {
        vec![build(&normalized[2], &normalized[4])?]
    };
    Ok(Some(schedules))
}

pub(crate) fn validate(value: &str) -> Result<(), String> {
    schedules(value).map(|_| ())
}

pub(crate) fn next_at(value: &str, after: DateTime<Utc>) -> Option<DateTime<Utc>> {
    schedules(value)
        .ok()
        .flatten()?
        .iter()
        .filter_map(|schedule| schedule.after(&after).next())
        .min()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn next(value: &str) -> Option<String> {
        next_at(value, "2026-11-06T12:00:00Z".parse().unwrap()).map(|time| time.to_rfc3339())
    }
    #[test]
    fn weekday_numbers_names_ranges_steps_and_day_union_match_linux() {
        for sunday in ["0", "7", "sun", "SUN"] {
            assert_eq!(
                next(&format!("0 0 * * {sunday}")),
                Some("2026-11-08T00:00:00+00:00".into())
            );
        }
        assert_eq!(
            next("0 0 * * 1-5"),
            Some("2026-11-09T00:00:00+00:00".into())
        );
        assert_eq!(
            next("0 0 * * 0-7/2"),
            Some("2026-11-07T00:00:00+00:00".into())
        );
        assert_eq!(
            next("0 0 1 * mon"),
            Some("2026-11-09T00:00:00+00:00".into())
        );
        assert_eq!(next("@monthly"), Some("2026-12-01T00:00:00+00:00".into()));
        assert_eq!(next("@reboot"), None);
    }
    #[test]
    fn malformed_or_injected_schedules_are_rejected() {
        for expression in [
            "0 0 * * 8",
            "+1 0 * * *",
            "*/+2 * * * *",
            "60 0 * * *",
            "0 24 * * *",
            "0 0 * 13 *",
            "*/0 * * * *",
            "* * * * ?",
            "* * * * *\n@reboot unexpected",
            "* * * *",
            "* * * * 5-1",
            "@unknown",
        ] {
            assert!(validate(expression).is_err(), "accepted {expression}");
        }
    }
    #[test]
    fn system_jobs_and_quoted_metadata_keep_the_command_intact() {
        let parsed = entry("@daily root printf 'two  spaces'", true).unwrap();
        assert_eq!(parsed.user, Some("root"));
        assert_eq!(parsed.command, "printf 'two  spaces'");
        assert!(entry("MAILTO = 'one two three four five six'", false).is_none());
        assert_eq!(
            metadata("printf 'literal # ternway:user:not-metadata'"),
            ("printf 'literal # ternway:user:not-metadata'", None)
        );
        assert_eq!(
            metadata("printf 'two  spaces' # ternway:user:example"),
            ("printf 'two  spaces'", Some("user:example"))
        );
    }
}
