use std::panic::AssertUnwindSafe;

use sandbox_firecracker::api_request_gate::RequestRoute;

use super::*;

fn backend_path(fixture: &Fixture) -> io::Result<std::path::PathBuf> {
    fixture
        .backend
        .local_addr()?
        .as_pathname()
        .map(std::path::Path::to_path_buf)
        .ok_or_else(|| io::Error::other("backend listener has no socket path"))
}

async fn respond(listener: &UnixListener, expected_path: &str) -> io::Result<serde_json::Value> {
    let (socket, _) = listener.accept().await?;
    let mut socket = BufReader::new(socket);
    let mut line = String::new();
    socket.read_line(&mut line).await?;
    assert_eq!(line.split_whitespace().nth(1), Some(expected_path));
    let mut length = None;
    loop {
        line.clear();
        assert_ne!(socket.read_line(&mut line).await?, 0);
        if line == "\r\n" {
            break;
        }
        if let Some((name, value)) = line.split_once(':')
            && name.eq_ignore_ascii_case("content-length")
        {
            length = Some(value.trim().parse::<usize>().map_err(io::Error::other)?);
        }
    }
    let length = length.ok_or_else(|| io::Error::other("request has no content length"))?;
    let mut body = vec![0; length];
    socket.read_exact(&mut body).await?;
    socket.get_mut().write_all(RESPONSE).await?;
    serde_json::from_slice(&body).map_err(io::Error::other)
}

#[tokio::test]
async fn routes_actual_clients_created_before_and_inside_the_scope() {
    for transition in [Transition::Resume, Transition::Pause] {
        let mut fixture = Fixture::new(transition).unwrap();
        let backend = backend_path(&fixture).unwrap();
        let route = RequestRoute::new(backend.clone(), fixture.front.clone()).unwrap();
        let api = (transition == Transition::Resume).then(|| ApiClient::new(&backend).unwrap());
        let client = tokio::spawn(route.scope(async move {
            let api = api.unwrap_or_else(|| ApiClient::new(&backend).unwrap());
            match transition {
                Transition::Resume => api.resume().await,
                Transition::Pause => api.pause().await,
            }
        }));
        let request = (&mut fixture.control.arrived).await.unwrap();
        assert_eq!(request.transition, transition);
        assert!(fixture.backend.accept().now_or_never().is_none());
        fixture.control.release.send(()).unwrap();
        let mut backend = actual_request(&fixture.backend, &request.raw)
            .await
            .unwrap();
        let response = if transition == Transition::Resume {
            RESPONSE.to_vec()
        } else {
            let body = br#"{"fault_message":"pause refused"}"#;
            [
                format!(
                    "HTTP/1.1 400 Bad Request\r\nContent-Length: {}\r\n\r\n",
                    body.len()
                )
                .as_bytes(),
                body,
            ]
            .concat()
        };
        backend.write_all(&response).await.unwrap();
        let result = client.await.unwrap();
        if transition == Transition::Resume {
            result.unwrap();
        } else {
            assert!(
                matches!(result, Err(ApiError::Http { status: 400, body }) if body == "pause refused")
            );
        }
        match fixture.producer.join().await.unwrap() {
            RequestOutcome::ResponseDrained {
                request: actual,
                response: actual_response,
                ..
            } => {
                assert_eq!(actual, request);
                assert_eq!(actual_response, response);
            }
            outcome => panic!("unexpected routed result: {outcome:?}"),
        }
    }
}

#[tokio::test]
async fn unrelated_commands_keep_the_original_transport() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("backend.sock");
    let backend = UnixListener::bind(&path).unwrap();
    let api = ApiClient::new(&path).unwrap();
    // A nonexistent front also proves these commands do not depend on it.
    let route = RequestRoute::new(path, root.path().join("missing.sock")).unwrap();
    let ((), ()) = tokio::join!(
        route.scope(async {
            api.patch_balloon(123).await.unwrap();
            api.start_instance().await.unwrap();
        }),
        async {
            assert_eq!(
                respond(&backend, "/balloon").await.unwrap()["amount_mib"],
                123
            );
            assert_eq!(
                respond(&backend, "/actions").await.unwrap()["action_type"],
                "InstanceStart"
            );
        }
    );
}

#[tokio::test]
async fn other_sockets_and_spawned_tasks_do_not_inherit_a_route() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("backend.sock");
    let backend = UnixListener::bind(&path).unwrap();
    let other_path = root.path().join("other.sock");
    let other = UnixListener::bind(&other_path).unwrap();
    let front_path = root.path().join("front.sock");
    let front = UnixListener::bind(&front_path).unwrap();
    let api = ApiClient::new(&path).unwrap();
    let route = RequestRoute::new(path, front_path).unwrap();
    let ((), ()) = tokio::join!(
        route.scope(async {
            ApiClient::new(&other_path).unwrap().pause().await.unwrap();
            tokio::spawn(async move { api.resume().await })
                .await
                .unwrap()
                .unwrap();
        }),
        async {
            for listener in [&other, &backend] {
                tokio::select! {
                    body = respond(listener, "/vm") => assert!(body.unwrap()["state"].is_string()),
                    _ = front.accept() => panic!("unrelated task/socket entered the route"),
                }
            }
        }
    );
}

#[tokio::test]
async fn nested_scopes_restore_after_completion_and_unwind() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("backend.sock");
    let backend = UnixListener::bind(&path).unwrap();
    let outer_path = root.path().join("outer.sock");
    let outer = UnixListener::bind(&outer_path).unwrap();
    let inner_path = root.path().join("inner.sock");
    let inner = UnixListener::bind(&inner_path).unwrap();
    let api = ApiClient::new(&path).unwrap();
    let outer_route = RequestRoute::new(path.clone(), outer_path).unwrap();
    let inner_route = RequestRoute::new(path.clone(), inner_path.clone()).unwrap();
    let ((), ()) = tokio::join!(
        async {
            outer_route
                .scope(async {
                    inner_route.scope(api.resume()).await.unwrap();
                    let panic_route = RequestRoute::new(path, inner_path).unwrap();
                    assert!(
                        AssertUnwindSafe(panic_route.scope(async { panic!("cancelled fixture") }))
                            .catch_unwind()
                            .await
                            .is_err()
                    );
                    api.pause().await.unwrap();
                })
                .await;
            api.resume().await.unwrap();
        },
        async {
            assert_eq!(respond(&inner, "/vm").await.unwrap()["state"], "Resumed");
            assert_eq!(respond(&outer, "/vm").await.unwrap()["state"], "Paused");
            assert_eq!(respond(&backend, "/vm").await.unwrap()["state"], "Resumed");
        }
    );
}

#[tokio::test]
async fn dropped_scope_restores_routing_and_retains_the_accepted_late_response() {
    let mut fixture = Fixture::new(Transition::Resume).unwrap();
    let api = ApiClient::new(&backend_path(&fixture).unwrap()).unwrap();
    let route = RequestRoute::new(backend_path(&fixture).unwrap(), fixture.front.clone()).unwrap();
    let mut operation = Box::pin(route.scope(api.resume()));
    let request = tokio::select! {
        result = &mut operation => panic!("request completed before release: {result:?}"),
        request = &mut fixture.control.arrived => request.unwrap(),
    };
    fixture.control.release.send(()).unwrap();
    let mut accepted = actual_request(&fixture.backend, &request.raw)
        .await
        .unwrap();
    drop(operation);
    assert!(fixture.producer.join().now_or_never().is_none());
    // Another real request progresses while the original accepted producer waits.
    let (result, body) = tokio::join!(api.pause(), respond(&fixture.backend, "/vm"));
    result.unwrap();
    assert_eq!(body.unwrap()["state"], "Paused");
    let response = b"HTTP/1.1 400 Bad Request\r\nContent-Length: 5\r\n\r\nfault";
    accepted.write_all(response).await.unwrap();
    match fixture.producer.join().await.unwrap() {
        RequestOutcome::ResponseDrained {
            request: actual,
            status,
            response: actual_response,
            ..
        } => {
            assert_eq!(actual, request);
            assert_eq!(status, 400);
            assert_eq!(actual_response, response);
        }
        outcome => panic!("accepted response lost after scope drop: {outcome:?}"),
    }
}

#[tokio::test]
async fn selected_front_failure_never_falls_back_to_backend() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("backend.sock");
    let backend = UnixListener::bind(&path).unwrap();
    let api = ApiClient::new(&path).unwrap();
    let route = RequestRoute::new(path.clone(), root.path().join("missing.sock")).unwrap();
    assert!(matches!(
        route.scope(api.resume()).await,
        Err(ApiError::Connect(_))
    ));
    assert!(backend.accept().now_or_never().is_none());
    assert!(RequestRoute::new(path.clone(), path.clone()).is_err());
    assert!(RequestRoute::new(path, "".into()).is_err());
}
