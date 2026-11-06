//! Fixed synthetic SRP verifier, independently derived from the public test credentials.

use crypto_bigint::{
    BoxedUint,
    modular::{BoxedMontyForm, BoxedMontyParams},
};

// RFC 5054 4096-bit N, g = 5, password = "test-password", salt = [0x13; 32].
// d = PBKDF2-HMAC-SHA512(password, salt, 10_000, 128 bytes);
// x = SHA512(salt || SHA512(":" || d)); v = g^x mod N.
// Python hashlib and integer modular exponentiation independently reproduce the
// original peer value. Every client KDF and fresh server proof still runs.
pub fn verifier(
    params: &BoxedMontyParams,
) -> Result<BoxedMontyForm, Box<dyn std::error::Error + Send + Sync>> {
    let bytes = hex::decode(concat!(
        "49d0aada61a3ce4c7265ce12e890ab331a2a7614640ca619728d97ecafef3cb1",
        "294c4819ec77f5edf83620104feac62fe3fa54664745ec134ef76086406d8fbc",
        "7af472b494cbcd3794aababc92f47288a52a3b8951e9cfe9de8e4da5eb65e645",
        "d3840926c48c94aaa50efef2e8cb0fe2a405b6be1873f39469a71d0ad134d81e",
        "b8ef76d19125ef7f5c4c248c127a69fdef9966d7b2fc4ea9a7ae34bc1f92d1b8",
        "044442f350e307e8ae792545992aeec57362343d9da6b8ec712f1e3ae234b18f",
        "1944f0657ba3d378e67bbde72a904b149ecbb14f13de22ecbd819966294cfc9e",
        "81ef8e1204f6b6899c487d85b992b5bfbc1f613d9d0bfea900c4149d2bd1e884",
        "5ea6237b6a2418b652eb774cbe4e568e793f7dee5d078c1f024c54137099b503",
        "37ec69c4f567f2ce81d784e660b2083c50e70b385ab712d3e98e890275d456db",
        "582ad465d9d6c919e35662ce46f00725289b1c7445a898eeeca2cf47b9443597",
        "a28528a63227a199a3d780f1c1bcae86446c8fc098ca02e6e25518b1415ca1e4",
        "37be631832da6d8ce334d3c93447d2db65ed766aab6ef5f2d7888ab373557c77",
        "786a3b01706b41be27a6ad1667612f3e076fd83c2783af9c6b3a9787a5acdd4d",
        "746fef9990e2495cafc71089459606ccf99014256dfa55cddf58768477ad0475",
        "315b2a2ff852637edf4d753e1ee591730ff2b995572ab5b80280f7185890ea31",
    ))
    .map_err(|error| format!("invalid synthetic SRP verifier hex: {error:?}"))?;
    let value = BoxedUint::from_be_slice(&bytes, 4096)
        .map_err(|error| format!("invalid synthetic SRP verifier: {error:?}"))?;
    Ok(BoxedMontyForm::new(value, params))
}
