//! Public synthetic server identity for RSA protocol fixtures, never a production key.

use base64::Engine as _;
use rsa::{RsaPrivateKey, pkcs8::DecodePrivateKey};

// The peer's key generation is not an application contract. Decode an independent
// 2048-bit/e65537 identity instead; every client exchange, proof and random value
// still comes from the real authentication path under test.
pub fn server_key() -> Result<RsaPrivateKey, Box<dyn std::error::Error + Send + Sync>> {
    let der = base64::engine::general_purpose::STANDARD
        .decode(concat!(
            "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCq7lHxfK/Dsv/BBSMbdm6yW9Mp",
            "78bV/+9bqrz+1U2jc3dP8YUXIKDaRrsbLTn2x3tUmByCWqaDjRB5ebvxPABT3EKJ4Pv4qPtkONgL",
            "hFe4T/dw97O+aIB91Xfb+2ibF+FJmjGAawbVUsBv5oKJJBNbnRa1qLX/WMZTTlWEnrx2L//bBFjm",
            "T5g++B7pcrz2F9dCMlNBo7U3BI1sZ4moriWgCC6azQDZeW9Yk9XpihvaumnMQuAIPkQByi6PkxGj",
            "TkaLiKQa0MuqwNzjz3aiE/SPPAO5+RQPIJTLpSchDRk7rd5Q03yDOxnopKKKvfwGj9PtWx0aemjl",
            "qWSMgEu8URSVAgMBAAECggEAAmR2HXB0VMOaL/HcUcqC/4865B2EU17ArsJ84LXxA9HwoEmuHQ8v",
            "I3XVsXOKvpSAemjHMxa8S+h/sGOTX7TckpkN6Vz8XCZ7n27F9jRytm/ZPOmvNjiey8ioGqyNch9r",
            "TNG2rah2Z+EbD5FSz9VxAH36PK4aQ7xAgBdtBP92omTTafFRkjkbLYTJwrwE8T00do+mXHzV0/iQ",
            "Q/axe/PswkVx/RVhSNW5TcV0owV/cqVn0c1Uho++YvmWi2tENYM4vtFtKv1fwETcPeSvJhr5/M8v",
            "hukZ9s1RAIbJBYTRng0r7rMf/p0dRqXvEeZ22uz/5EIMlgcV4WE+u9KzLEBRoQKBgQDrDvY7Gm5g",
            "0WMBlfgtbdn83dGeGZZB8U1LUjRjEFXk9D3A+vpN2+S2oQhSTiJI92hhHKuel39zFuRhWUP4RItG",
            "wyjZgYPt5k+K6vKfW3+FAJoRuW8tZPqCIC9IIriTDs5hwkX5QKY4Mn84GKtG8EfO6KWuVnPKGZyM",
            "1vOYm8SmjQKBgQC6KMkopix/TBoUfR+rXlZ+4LzyW23ORJwe/Wz+3VLpLudCxt8nv02OZa5TWg/w",
            "1FSnqoaJ6baJq413SsZU/xM5Q1KZPoa/udOI8NRqsOA9s2IuLX7FzK1IvIEKfFJLFeMy6h3D12H/",
            "4QbVx6SJj4Yvzk3GxoJ6yPH6nZY6xpYIKQKBgQCErIJA4+9PSIBIgdx9z9ZNiuppAWo1ODz3eaPG",
            "Eo9Y1p8QkNi9H5OdnZDz29QwOS06OxOHRV2TmWU4qUjbFd1DCJ7C/f54Rhm5gFmHpv54FNnhjTf6",
            "eFeJIR9u6OIjZyUIOr6CLIJlj+MMx6fNN4xgdiImH/flJ8WcHSuLhMhfdQKBgDkcjipEYN5k8JNc",
            "l7yxYoPmWtFXr2ZasjLnuOqv5+HWG+jmrku5awfGtiaoOL+/xIDz1fa1luTBltMEQ7iL0M/+kXam",
            "Mhzb28PlbqWUwhbr07ErD/uLAZaRDl2zKmQSwPM71AnjKBOia8BmUVpKh/ZeqonTGPCmeWZTtmUt",
            "y5WRAoGAStUjuWP5HH1co15c10194/CgrAGCNnEdbjWXbd/6VGZ3tmolYSpe6iK/eY2xWr1UKxyu",
            "dOMK5vthyQudynlkFXxJUOzrgpUq0TFoFCbWRDozVfgfd92XnKIFFS+B/oPWhY2ytWlw++N0WSJq",
            "LwrMCZgMuxh1XoCe/IieIyBXPcU=",
        ))
        .map_err(|error| format!("invalid synthetic RSA key: {error}"))?;
    Ok(RsaPrivateKey::from_pkcs8_der(&der)?)
}
