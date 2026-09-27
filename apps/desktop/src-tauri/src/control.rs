use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use std::{io::Read, path::Path, time::Duration};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonStatus {
    pub instance_id: String,
    pub process: ProcessStatus,
    pub runtime: RuntimeStatus,
    pub active_work_count: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ProcessStatus {
    pub pid: u32,
    pub state: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RuntimeStatus {
    pub state: String,
}

pub struct Control(Client);

impl Control {
    pub fn new(socket: &Path) -> Result<Self, String> {
        Client::builder()
            .unix_socket(socket.to_path_buf())
            .no_proxy()
            .timeout(Duration::from_secs(2))
            .build()
            .map(Self)
            .map_err(|error| error.to_string())
    }

    fn request<T: serde::de::DeserializeOwned>(
        &self,
        method: reqwest::Method,
        path: &str,
        expected: u16,
    ) -> Result<T, String> {
        let response = self
            .0
            .request(method, format!("http://localhost{path}"))
            .send()
            .map_err(|error| error.to_string())?;
        let status = response.status().as_u16();
        let mut body = Vec::new();
        response
            .take(65537)
            .read_to_end(&mut body)
            .map_err(|error| error.to_string())?;
        if body.len() > 65536 {
            return Err("호스트 응답이 허용 크기를 초과했습니다.".into());
        }
        if status != expected {
            return Err(format!("HTTP {status}: {}", String::from_utf8_lossy(&body)));
        }
        serde_json::from_slice(&body).map_err(|error| error.to_string())
    }

    pub fn status(&self) -> Result<DaemonStatus, String> {
        self.request(reqwest::Method::GET, "/status", 200)
    }

    pub fn restart(&self) -> Result<(), String> {
        #[derive(Deserialize)]
        struct Accepted {
            accepted: bool,
        }
        let result: Accepted = self.request(reqwest::Method::POST, "/restart", 202)?;
        if result.accepted {
            Ok(())
        } else {
            Err("호스트가 재시작을 수락하지 않았습니다.".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader, Write},
        os::unix::net::UnixListener,
        thread,
    };

    fn server(
        response: String,
        expected: &'static str,
    ) -> (tempfile::TempDir, Control, thread::JoinHandle<()>) {
        let directory = tempfile::tempdir_in("/tmp").unwrap();
        let socket = directory.path().join("control.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let task = thread::spawn(move || {
            let (mut connection, _) = listener.accept().unwrap();
            connection
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut reader = BufReader::new(&connection);
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            assert_eq!(line.trim_end(), expected);
            loop {
                line.clear();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
            }
            connection.write_all(response.as_bytes()).unwrap();
        });
        (directory, Control::new(&socket).unwrap(), task)
    }

    #[test]
    fn reads_host_identity_and_work_over_a_real_unix_socket() {
        let body = r#"{"instanceId":"host-one","process":{"pid":42,"state":"running"},"runtime":{"state":"ready"},"activeWorkCount":3}"#;
        let (_directory, control, task) = server(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            ),
            "GET /status HTTP/1.1",
        );
        let status = control.status().unwrap();
        assert_eq!(status.instance_id, "host-one");
        assert_eq!(status.process.pid, 42);
        assert_eq!(status.active_work_count, 3);
        task.join().unwrap();
    }

    #[test]
    fn preserves_restart_rejections_instead_of_reporting_success() {
        let body = r#"{"error":{"code":"restart_in_progress"}}"#;
        let (_directory, control, task) = server(
            format!(
                "HTTP/1.1 409 Conflict\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            ),
            "POST /restart HTTP/1.1",
        );
        assert!(
            control
                .restart()
                .unwrap_err()
                .contains("restart_in_progress")
        );
        task.join().unwrap();
    }

    #[test]
    fn accepts_chunked_restart_acknowledgement() {
        let (_directory, control, task) = server("HTTP/1.1 202 Accepted\r\nTransfer-Encoding: chunked\r\n\r\n11\r\n{\"accepted\":true}\r\n0\r\n\r\n".into(), "POST /restart HTTP/1.1");
        control.restart().unwrap();
        task.join().unwrap();
    }

    #[test]
    fn rejects_malformed_host_responses_and_missing_sockets() {
        let (_directory, control, task) = server(
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}".into(),
            "GET /status HTTP/1.1",
        );
        assert!(control.status().is_err());
        task.join().unwrap();
        let directory = tempfile::tempdir().unwrap();
        assert!(
            Control::new(&directory.path().join("missing"))
                .unwrap()
                .status()
                .is_err()
        );
    }
}
