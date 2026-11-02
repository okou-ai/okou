use super::*;
use rsa::RsaPrivateKey;

#[test]
fn maximum_username_fits_the_rsa_plaintext_without_truncation() {
    let mut rng = StdRng::try_from_rng(&mut SysRng).expect("OS entropy");
    let private = RsaPrivateKey::new(&mut rng, 2048).expect("synthetic RSA key");
    let username = vec![b'a'; 234];
    let encrypted = encrypted_username(&RsaPublicKey::from(&private), &username)
        .expect("exact PKCS#1 v1.5 bound");
    let plaintext = private
        .decrypt(Pkcs1v15Encrypt, &encrypted)
        .expect("decrypt");
    assert_eq!(plaintext.len(), 245);
    assert_eq!(plaintext.get(8..242), Some(username.as_slice()));
    assert_eq!(plaintext.get(242..), Some(&[0, 0, 0][..]));
}
