use std::io::IsTerminal;

use clap::{Args, ValueEnum};
use tracing::Subscriber;
use tracing_subscriber::{fmt::MakeWriter, util::SubscriberInitExt, EnvFilter};

#[derive(Args, Debug)]
pub(super) struct LoggingOptions {
    /// Log output format. JSON writes one structured event per line.
    #[arg(long, env = "PCASH_LOG_FORMAT", value_enum, default_value = "full")]
    log_format: LogFormat,

    /// Text log color. Auto respects stdout's terminal status and NO_COLOR;
    /// JSON always disables color.
    #[arg(long, env = "PCASH_LOG_COLOR", value_enum, default_value = "never")]
    log_color: LogColor,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
enum LogFormat {
    Full,
    Compact,
    Pretty,
    Json,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
enum LogColor {
    Never,
    Auto,
    Always,
}

impl LogColor {
    fn ansi(self, is_terminal: bool, no_color: bool) -> bool {
        match self {
            Self::Never => false,
            Self::Auto => is_terminal && !no_color,
            Self::Always => true,
        }
    }
}

impl LoggingOptions {
    pub(super) fn init(&self) {
        let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
        let no_color = std::env::var_os("NO_COLOR").is_some_and(|value| !value.is_empty());
        let ansi = self
            .log_color
            .ansi(std::io::stdout().is_terminal(), no_color);
        self.subscriber(filter, ansi, std::io::stdout).init();
    }

    fn subscriber<W>(
        &self,
        filter: EnvFilter,
        ansi: bool,
        writer: W,
    ) -> Box<dyn Subscriber + Send + Sync>
    where
        W: for<'a> MakeWriter<'a> + Send + Sync + 'static,
    {
        let builder = tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_ansi(ansi)
            .with_writer(writer);
        match self.log_format {
            LogFormat::Full => Box::new(builder.finish()),
            LogFormat::Compact => Box::new(builder.compact().finish()),
            LogFormat::Pretty => Box::new(builder.pretty().finish()),
            LogFormat::Json => Box::new(builder.json().with_ansi(false).finish()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::{CommandFactory, FromArgMatches};
    use std::io::Write;
    use std::sync::{Arc, Mutex};

    fn parse(args: &[&str], with_env: bool) -> Result<LoggingOptions, clap::Error> {
        let matches = crate::Cli::command()
            .mut_args(|arg| {
                if with_env && matches!(arg.get_id().as_str(), "log_format" | "log_color") {
                    arg
                } else {
                    arg.env(None::<&str>)
                }
            })
            .try_get_matches_from(
                [
                    "pcash-node",
                    "--l1-rpc",
                    "http://localhost:8545",
                    "--beacon-api",
                    "http://localhost:5052",
                    "--data-dir",
                    "/unused",
                    "--network",
                    "testnet",
                ]
                .into_iter()
                .chain(args.iter().copied()),
            )?;
        Ok(crate::Cli::from_arg_matches(&matches)?.logging)
    }

    #[test]
    fn cli_defaults_and_values() {
        let defaults = parse(&[], false).unwrap();
        assert_eq!(defaults.log_format, LogFormat::Full);
        assert_eq!(defaults.log_color, LogColor::Never);
        for (value, expected) in [
            ("full", LogFormat::Full),
            ("compact", LogFormat::Compact),
            ("pretty", LogFormat::Pretty),
            ("json", LogFormat::Json),
        ] {
            assert_eq!(
                parse(&["--log-format", value], false).unwrap().log_format,
                expected
            );
        }
        for (value, expected) in [
            ("never", LogColor::Never),
            ("auto", LogColor::Auto),
            ("always", LogColor::Always),
        ] {
            assert_eq!(
                parse(&["--log-color", value], false).unwrap().log_color,
                expected
            );
        }
        for flag in ["--log-format", "--log-color"] {
            assert_eq!(
                parse(&[flag, "invalid"], false).unwrap_err().kind(),
                clap::error::ErrorKind::InvalidValue
            );
        }
    }

    #[test]
    fn environment_settings_and_cli_precedence() {
        for (case, format, color) in [
            ("environment", "json", "always"),
            ("override", "json", "always"),
            ("invalid-format", "invalid", "never"),
            ("invalid-color", "full", "invalid"),
        ] {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "logging::tests::environment_child",
                    "--nocapture",
                ])
                .env("PCASH_LOGGING_TEST_CHILD", case)
                .env("PCASH_LOG_FORMAT", format)
                .env("PCASH_LOG_COLOR", color)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{case}: {}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }

    #[test]
    fn environment_child() {
        let Ok(case) = std::env::var("PCASH_LOGGING_TEST_CHILD") else {
            return;
        };
        if case.starts_with("invalid-") {
            assert_eq!(
                parse(&[], true).unwrap_err().kind(),
                clap::error::ErrorKind::InvalidValue
            );
        } else if case == "override" {
            let options =
                parse(&["--log-format", "compact", "--log-color", "never"], true).unwrap();
            assert_eq!(options.log_format, LogFormat::Compact);
            assert_eq!(options.log_color, LogColor::Never);
        } else {
            let options = parse(&[], true).unwrap();
            assert_eq!(options.log_format, LogFormat::Json);
            assert_eq!(options.log_color, LogColor::Always);
        }
    }

    #[test]
    fn color_selection() {
        for (is_terminal, no_color, expected_auto) in [
            (false, false, false),
            (false, true, false),
            (true, false, true),
            (true, true, false),
        ] {
            assert!(!LogColor::Never.ansi(is_terminal, no_color));
            assert!(LogColor::Always.ansi(is_terminal, no_color));
            assert_eq!(LogColor::Auto.ansi(is_terminal, no_color), expected_auto);
        }
    }

    #[derive(Clone, Default)]
    struct Capture(Arc<Mutex<Vec<u8>>>);

    impl Write for Capture {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn render(options: &LoggingOptions, filter: &str) -> String {
        let output = Capture::default();
        let writer = output.clone();
        let subscriber = options.subscriber(
            EnvFilter::new(filter),
            options.log_color.ansi(false, false),
            move || writer.clone(),
        );
        tracing::subscriber::with_default(subscriber, || {
            let span = tracing::info_span!("derive", block = 42_u64);
            let _entered = span.enter();
            tracing::debug!("filtered debug event");
            tracing::info!(count = 7_u64, ready = true, "block committed");
            tracing::warn!("{}", crate::DEV_MODE_WARNING);
        });
        let bytes = output.0.lock().unwrap().clone();
        String::from_utf8(bytes).unwrap()
    }

    #[test]
    fn text_formats_and_color() {
        for (format, expected_layout) in [
            ("full", "derive{block=42}:"),
            ("compact", "derive:"),
            ("pretty", "\n    at "),
        ] {
            let plain = render(&parse(&["--log-format", format], false).unwrap(), "info");
            assert!(!plain.contains('\u{1b}'));
            assert!(plain.contains(expected_layout), "{format}: {plain}");
            assert!(plain.contains("block committed"));
            assert!(plain.contains("count"));
            assert!(plain.contains("derive"));
            assert!(!plain.contains("filtered debug event"));
            let colored = render(
                &parse(&["--log-format", format, "--log-color", "always"], false).unwrap(),
                "info",
            );
            assert!(colored.contains("\u{1b}["), "{format}");
        }
    }

    #[test]
    fn json_preserves_fields_spans_and_multiline_messages_without_color() {
        let output = render(
            &parse(&["--log-format", "json", "--log-color", "always"], false).unwrap(),
            "info",
        );
        assert!(!output.contains('\u{1b}'));
        let events: Vec<serde_json::Value> = output
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["level"], "INFO");
        assert!(events[0]["timestamp"].is_string());
        assert!(events[0]["target"].is_string());
        assert_eq!(events[0]["fields"]["message"], "block committed");
        assert_eq!(events[0]["fields"]["count"], 7);
        assert_eq!(events[0]["fields"]["ready"], true);
        assert_eq!(events[0]["span"]["name"], "derive");
        assert_eq!(events[0]["span"]["block"], 42);
        assert_eq!(events[0]["spans"][0]["name"], "derive");
        assert_eq!(events[1]["fields"]["message"], crate::DEV_MODE_WARNING);
    }

    #[test]
    fn filtering_applies_to_every_format() {
        for format in ["full", "compact", "pretty", "json"] {
            let output = render(&parse(&["--log-format", format], false).unwrap(), "warn");
            assert!(!output.contains("block committed"));
            assert!(!output.contains("filtered debug event"));
            assert!(output.contains("PCASH DEVELOPMENT MODE"));
        }
    }
}
