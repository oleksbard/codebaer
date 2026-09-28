use crate::AppError;

/// Only a web page: `open` and `xdg-open` would just as readily launch an app, a file or another scheme's handler.
fn web_url(url: &str) -> bool {
    url.strip_prefix("https://")
        .is_some_and(|rest| !rest.is_empty() && !rest.chars().any(|c| c.is_whitespace() || c.is_control()))
}

#[tauri::command(async)]
pub fn open_url(url: String) -> Result<(), AppError> {
    if !web_url(&url) {
        return Err(AppError::Io(format!("not a web address: {url}")));
    }
    crate::sys::open_url(&url)
}

#[cfg(test)]
mod tests {
    use super::{open_url, web_url};
    use crate::AppError;

    #[test]
    fn only_an_https_page_is_opened() {
        assert!(web_url("https://opencode.ai/download"));
        for bad in [
            "http://opencode.ai",
            "file:///Applications/Calculator.app",
            "/Applications/Calculator.app",
            "-a Calculator",
            "vscode://file/etc/hosts",
            "https://",
            "https://a b",
            "https://a\n",
            " https://a",
        ] {
            assert!(!web_url(bad), "{bad:?}");
        }
    }

    #[test]
    fn a_refused_address_never_reaches_open() {
        let err = open_url("file:///Applications/Calculator.app".into()).unwrap_err();
        assert_eq!(err, AppError::Io("not a web address: file:///Applications/Calculator.app".into()));
    }
}
