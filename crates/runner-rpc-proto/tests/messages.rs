use runner_rpc_proto::stream::{
    Frame, Reader, Writer,
    messages::{self, Message},
};

#[tokio::test]
async fn complete_messages_cross_frame_boundaries_and_end_without_socket_eof() {
    let payload = vec![42; 180_000];
    let mut bytes = Vec::new();
    let mut output = Writer::input(&mut bytes);
    messages::write(&mut output, &payload, 200_000)
        .await
        .unwrap();
    messages::write(&mut output, b"second", 200_000)
        .await
        .unwrap();
    output.send(&Frame::End).await.unwrap();
    let mut input = Reader::input(bytes.as_slice());
    assert!(
        matches!(messages::read(&mut input,200_000).await.unwrap(),Some(Message::Data(data)) if data==payload)
    );
    assert!(
        matches!(messages::read(&mut input,200_000).await.unwrap(),Some(Message::Data(data)) if data==b"second")
    );
    assert!(matches!(
        messages::read(&mut input, 200_000).await.unwrap(),
        Some(Message::End)
    ));
    assert!(messages::read(&mut input, 200_000).await.unwrap().is_none());
}

#[tokio::test]
async fn corrupt_incomplete_and_over_limit_messages_are_rejected() {
    for frames in [
        vec![Frame::Data(vec![0, 0, 0])],
        vec![Frame::Data(vec![0, 0, 0, 0])],
        vec![Frame::Data(vec![0, 0, 0, 1, 1, 2])],
        vec![Frame::Data(vec![0, 0, 0, 2, 1]), Frame::End],
        vec![Frame::Data(vec![255, 255, 255, 255])],
    ] {
        let mut bytes = Vec::new();
        let mut output = Writer::input(&mut bytes);
        for frame in frames {
            output.send(&frame).await.unwrap();
        }
        assert!(
            messages::read(&mut Reader::input(bytes.as_slice()), 100)
                .await
                .is_err()
        );
    }
    let mut output = Writer::input(Vec::new());
    assert!(messages::write(&mut output, b"too big", 2).await.is_err());
}
