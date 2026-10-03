/* Narrow private MIT Kerberos initiator. Protocol stdout only; no diagnostic causes. */
#include "isolation.h"
#include <sys/random.h>
#include <krb5.h>
/* Maintained MIT encoder; declaration from pinned 1.22.2 src/include/k5-int.h.
   Private SDK interface: recheck this exact declaration on every pin upgrade. */
extern krb5_error_code encode_krb5_ticket(const krb5_ticket *rep, krb5_data **code);
#include <profile.h>
#include <gssapi/gssapi.h>
#include <gssapi/gssapi_krb5.h>
#define FRAME_MAX 131072U
#define TICKET_MAX 49152U
#define KDC_MAX 65536U
#define REQUIRED_FLAGS (GSS_C_MUTUAL_FLAG | GSS_C_REPLAY_FLAG | GSS_C_SEQUENCE_FLAG | GSS_C_INTEG_FLAG)
#define REFUSED_FLAGS (GSS_C_DELEG_FLAG | GSS_C_DELEG_POLICY_FLAG | GSS_C_ANON_FLAG)
static unsigned char input[FRAME_MAX], output[FRAME_MAX];
static uint32_t sequence;
static size_t input_size, position;
static unsigned mode, stage, exchanges;
static size_t exchange_bytes;
static krb5_context context;
static profile_t profile;
static krb5_principal initiator, target;
static krb5_ccache source_cache, service_cache;
static krb5_creds initial;
static gss_cred_id_t credential = GSS_C_NO_CREDENTIAL;
static gss_ctx_id_t security = GSS_C_NO_CONTEXT;
static gss_name_t local_name = GSS_C_NO_NAME, target_name = GSS_C_NO_NAME;
static unsigned char password[1024];
static unsigned ticket_life, renew_life;
static krb5_timestamp service_end;
static int native_error = 1;
static uint32_t read32(const unsigned char *p) {
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3];
}
static void write32(unsigned char *p, uint32_t n) {
    p[0] = (unsigned char)(n >> 24); p[1] = (unsigned char)(n >> 16);
    p[2] = (unsigned char)(n >> 8); p[3] = (unsigned char)n;
}
static int all_io(int fd, void *buffer, size_t size, int writing) {
    unsigned char *p = buffer;
    while (size) {
        ssize_t n = writing ? write(fd, p, size) : read(fd, p, size);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0 || (size_t)n > size) return -1;
        p += n; size -= (size_t)n;
    }
    return 0;
}
static int send_frame(unsigned kind, const void *body, size_t size) {
    unsigned char header[16] = {0,0,0,0,'K','R','B','2',2,0,0,0,0,0,0,0};
    if (size > FRAME_MAX) return -1;
    write32(header, (uint32_t)size); header[9] = (unsigned char)kind; write32(header + 12, sequence);
    return all_io(1, header, sizeof(header), 1) || all_io(1, (void *)body, size, 1) ? -1 : 0;
}
static int receive_frame(unsigned *kind, uint32_t expected) {
    unsigned char header[16];
    erase(input, sizeof(input));
    if (all_io(0, header, sizeof(header), 0) || memcmp(header + 4, "KRB2", 4) ||
        header[8] != 2 || header[10] || header[11] || read32(header + 12) != expected) return -1;
    input_size = read32(header);
    if (input_size > FRAME_MAX || all_io(0, input, input_size, 0)) return -1;
    *kind = header[9]; position = 0;
    return 0;
}
static const unsigned char *take(size_t n) {
    if (position > input_size || n > input_size - position) return NULL;
    const unsigned char *p = input + position; position += n; return p;
}
static int integer(uint32_t *n) {
    const unsigned char *p = take(4); if (!p) return -1; *n = read32(p); return 0;
}
static int string(krb5_data *part) {
    const unsigned char *p = take(2);
    if (!p) return -1;
    unsigned size = ((unsigned)p[0] << 8) | p[1];
    p = take(size);
    if (!p || !size || size > 255 || memchr(p, 0, size)) return -1;
    part->data = malloc(size + 1);
    if (!part->data) return -1;
    memcpy(part->data, p, size); part->data[size] = 0; part->length = size;
    return 0;
}
static int principal(krb5_principal *name) {
    krb5_principal p = calloc(1, sizeof(*p));
    if (!p) return -1;
    *name = p;
    if (string(&p->realm)) return -1;
    const unsigned char *count = take(1);
    if (!count || !*count || *count > 8) return -1;
    p->length = *count; p->type = KRB5_NT_PRINCIPAL;
    p->data = calloc((size_t)p->length, sizeof(*p->data));
    if (!p->data) { p->length = 0; return -1; }
    size_t bytes = p->realm.length;
    for (int i = 0; i < p->length; ++i) {
        if (string(&p->data[i])) return -1;
        bytes += p->data[i].length;
    }
    return bytes > 1024 ? -1 : 0;
}
static int data_equals(const krb5_data *a, const krb5_data *b) {
    return a->length == b->length && !memcmp(a->data, b->data, a->length);
}
static int data_literal(const krb5_data *a, const char *b) {
    return a->length == strlen(b) && !memcmp(a->data, b, a->length);
}
static int exact_principal(krb5_principal a, krb5_principal b) {
    if (!a || !b || a->length != b->length || !data_equals(&a->realm, &b->realm)) return 0;
    for (int i = 0; i < a->length; ++i) if (!data_equals(&a->data[i], &b->data[i])) return 0;
    return 1;
}
static long relation(const char *name, const char *value) {
    const char *keys[] = {"libdefaults", name, NULL};
    return profile_add_relation(profile, keys, value);
}
static krb5_error_code relay(krb5_context ctx, void *owner, const krb5_data *realm,
                            const krb5_data *request, krb5_data **new_request, krb5_data **reply) {
    (void)owner; *new_request = NULL; *reply = NULL;
    if (!mode || !data_equals(realm, &initiator->realm) || !request->length || request->length > KDC_MAX ||
        exchanges >= 16 || exchange_bytes + request->length > 524288) return KRB5_KDC_UNREACH;
    size_t size = realm->length;
    output[0] = (unsigned char)(size >> 8); output[1] = (unsigned char)size;
    memcpy(output + 2, realm->data, size); memcpy(output + 2 + size, request->data, request->length);
    ++exchanges; exchange_bytes += request->length;
    if (send_frame(32, output, 2 + size + request->length)) return KRB5_KDC_UNREACH;
    erase(output, sizeof(output));
    unsigned kind;
    if (receive_frame(&kind, sequence) || kind != 33 || !input_size || input_size > KDC_MAX ||
        exchange_bytes + input_size > 524288) return KRB5_KDC_UNREACH;
    exchange_bytes += input_size;
    if (krb5_copy_data(ctx, &(krb5_data){.length = (unsigned)input_size, .data = (char *)input}, reply)) return KRB5_KDC_UNREACH;
    erase(input, sizeof(input));
    return 0;
}
static int validate_ticket(krb5_creds *c, krb5_principal expected, int service) {
    krb5_timestamp now;
    krb5_ticket *decoded = NULL;
    krb5_data *canonical = NULL;
    int result = -1;
    if (!exact_principal(c->client, initiator) || !exact_principal(c->server, expected)) { native_error = 3; return -1; }
    if (!c->ticket.length || c->ticket.length > TICKET_MAX || c->is_skey || c->second_ticket.length ||
        (c->keyblock.enctype != ENCTYPE_AES128_CTS_HMAC_SHA1_96 && c->keyblock.enctype != ENCTYPE_AES256_CTS_HMAC_SHA1_96) ||
        c->keyblock.length != (c->keyblock.enctype == ENCTYPE_AES128_CTS_HMAC_SHA1_96 ? 16U : 32U)) return -1;
    if (krb5_timeofday(context, &now)) { native_error = 8; return -1; }
    if (c->times.authtime <= 0 || c->times.authtime > now ||
        (c->times.starttime && c->times.starttime > now) ||
        (c->times.starttime ? c->times.starttime : c->times.authtime) >= c->times.endtime) { native_error = 1; return -1; }
    if (c->times.endtime <= now) { native_error = 4; return -1; }
    /* This unencrypted outer-name check is structural, not ticket authenticity.
       It MUST precede cache storage and gss_init_sec_context/token output. */
    if (krb5_decode_ticket(&c->ticket, &decoded)) return -1;
    /* MIT deliberately ignores full_decode's remainder (encrypted-message padding).
       A cache Ticket is ONE canonical DER object, not an encrypted-message plaintext.
       Use the maintained encoder, not a second hand-written ASN.1 parser, to require
       complete consumption/canonical framing before any service-cache/token output. */
    if (encode_krb5_ticket(decoded, &canonical) || !data_equals(&c->ticket, canonical)) goto done;
    if (!exact_principal(decoded->server, expected)) native_error = 3;
    else if (decoded->enc_part.enctype != ENCTYPE_AES128_CTS_HMAC_SHA1_96 &&
             decoded->enc_part.enctype != ENCTYPE_AES256_CTS_HMAC_SHA1_96) native_error = 1;
    else { result = 0; if (service) service_end = c->times.endtime; }
done:
    if (canonical) { erase(canonical->data, canonical->length); krb5_free_data(context, canonical); }
    krb5_free_ticket(context, decoded);
    return result;
}
static int store_service(krb5_creds *c) {
    if (validate_ticket(c, target, 1) || krb5_cc_initialize(context, service_cache, initiator) ||
        krb5_cc_store_cred(context, service_cache, c)) return -1;
    return 0;
}
static int offline(void) {
    krb5_ccache file = NULL;
    krb5_cc_cursor cursor;
    krb5_principal client = NULL;
    krb5_creds c = {0}, extra = {0};
    int result = -1, started = 0;
    if (krb5_cc_resolve(context, "FILE:/input.cache", &file) ||
        krb5_cc_get_principal(context, file, &client) || !exact_principal(client, initiator) ||
        krb5_cc_start_seq_get(context, file, &cursor)) goto done;
    started = 1;
    if (krb5_cc_next_cred(context, file, &cursor, &c) ||
        (c.addresses && *c.addresses) || (c.authdata && *c.authdata) || store_service(&c) ||
        krb5_cc_next_cred(context, file, &cursor, &extra) != KRB5_CC_END) goto done;
    result = 0;
done:
    if (started) krb5_cc_end_seq_get(context, file, &cursor);
    krb5_free_cred_contents(context, &extra); krb5_free_cred_contents(context, &c);
    if (client) krb5_free_principal(context, client);
    if (file) krb5_cc_close(context, file);
    return result;
}
static int tgt_valid(krb5_creds *c) {
    krb5_principal s = c->server;
    if (!s || s->length != 2 || !data_equals(&s->realm, &initiator->realm) ||
        !data_literal(&s->data[0], "krbtgt") || !data_equals(&s->data[1], &initiator->realm)) { native_error = 3; return -1; }
    return validate_ticket(c, s, 0);
}
static int exchange_failure(krb5_error_code code);
static int get_service(void) {
    krb5_creds requested = {0}, *c = NULL;
    requested.client = initiator; requested.server = target;
    requested.keyblock.enctype = 0; /* Explicit profile permits AES17/18 only. */
    int result = -1;
    krb5_error_code code = krb5_get_credentials(context, KRB5_GC_NO_STORE, source_cache, &requested, &c);
    if (code) { native_error = exchange_failure(code); goto done; }
    if (store_service(c)) goto done;
    result = 0;
done:
    if (c) krb5_free_creds(context, c);
    return result;
}
static int exchange_failure(krb5_error_code code) {
    switch (code) {
        case KRB5KDC_ERR_PREAUTH_FAILED: case KRB5_PREAUTH_FAILED:
        case KRB5KRB_AP_ERR_BAD_INTEGRITY: case KRB5KDC_ERR_CLIENT_REVOKED:
        case KRB5KDC_ERR_KEY_EXP: case KRB5KDC_ERR_POLICY:
        case KRB5KDC_ERR_TGT_REVOKED: case KRB5KDC_ERR_SERVICE_REVOKED:
        case KRB5KDC_ERR_NAME_EXP: case KRB5KDC_ERR_SERVICE_EXP:
        case KRB5KDC_ERR_C_PRINCIPAL_UNKNOWN: case KRB5KDC_ERR_S_PRINCIPAL_UNKNOWN: return 2;
        case KRB5KRB_AP_ERR_TKT_EXPIRED: return 4;
        case KRB5_KT_NOTFOUND: return 3;
        case KRB5_KDC_UNREACH: return 6;
        default: return 8;
    }
}
static int acquire(void) {
    krb5_get_init_creds_opt *options = NULL;
    krb5_keytab keytab = NULL;
    int result = -1;
    krb5_free_cred_contents(context, &initial); memset(&initial, 0, sizeof(initial));
    if (krb5_get_init_creds_opt_alloc(context, &options)) goto done;
    krb5_get_init_creds_opt_set_canonicalize(options, 0);
    krb5_get_init_creds_opt_set_forwardable(options, 0);
    krb5_get_init_creds_opt_set_proxiable(options, 0);
    krb5_get_init_creds_opt_set_address_list(options, NULL);
    krb5_get_init_creds_opt_set_tkt_life(options, (krb5_deltat)ticket_life);
    krb5_get_init_creds_opt_set_renew_life(options, (krb5_deltat)renew_life);
    krb5_enctype types[] = {ENCTYPE_AES256_CTS_HMAC_SHA1_96, ENCTYPE_AES128_CTS_HMAC_SHA1_96};
    krb5_get_init_creds_opt_set_etype_list(options, types, 2);
    krb5_error_code code;
    if (mode == 1) {
        code = krb5_get_init_creds_password(context, &initial, initiator, (char *)password, NULL, NULL, 0, NULL, options);
    } else if (mode == 2) {
        code = krb5_kt_resolve(context, "FILE:/input.keytab", &keytab);
        if (!code) code = krb5_get_init_creds_keytab(context, &initial, initiator, keytab, 0, NULL, options);
    } else goto done;
    if (code) { native_error = exchange_failure(code); goto done; }
    if (tgt_valid(&initial) || krb5_cc_initialize(context, source_cache, initiator) ||
        krb5_cc_store_cred(context, source_cache, &initial) || get_service()) goto done;
    result = 0;
done:
    if (keytab) krb5_kt_close(context, keytab);
    if (options) krb5_get_init_creds_opt_free(context, options);
    return result;
}
static int renew(void) {
    krb5_timestamp now;
    krb5_creds c = {0};
    int result = -1;
    if (!mode) return -1;
    if (!(initial.ticket_flags & TKT_FLG_RENEWABLE)) { native_error = 9; return -1; }
    if (krb5_timeofday(context, &now)) { native_error = 8; return -1; }
    if (initial.times.renew_till <= now || initial.times.endtime <= now) { native_error = 10; return -1; }
    krb5_error_code code = krb5_get_renewed_creds(context, &c, initiator, source_cache, NULL);
    if (code) { native_error = exchange_failure(code); goto done; }
    if (tgt_valid(&c) || krb5_cc_initialize(context, source_cache, initiator) || krb5_cc_store_cred(context, source_cache, &c)) goto done;
    krb5_free_cred_contents(context, &initial); initial = c; memset(&c, 0, sizeof(c));
    result = get_service();
done:
    krb5_free_cred_contents(context, &c);
    return result;
}
static int import_name(krb5_principal principal, gss_name_t *name) {
    char *text = NULL;
    OM_uint32 minor;
    if (krb5_unparse_name(context, principal, &text)) return -1;
    gss_buffer_desc buffer = {strlen(text), text};
    OM_uint32 major = gss_import_name(&minor, &buffer, GSS_KRB5_NT_PRINCIPAL_NAME, name);
    krb5_free_unparsed_name(context, text);
    return major == GSS_S_COMPLETE ? 0 : -1;
}
static int same_name(gss_name_t a, gss_name_t b) {
    OM_uint32 minor; int equal = 0;
    return gss_compare_name(&minor, a, b, &equal) == GSS_S_COMPLETE && equal;
}
static int import_credential(void) {
    OM_uint32 minor, life = 0;
    gss_name_t name = GSS_C_NO_NAME;
    gss_cred_usage_t usage;
    if (credential != GSS_C_NO_CREDENTIAL) gss_release_cred(&minor, &credential);
    if (gss_krb5_import_cred(&minor, service_cache, initiator, NULL, &credential) != GSS_S_COMPLETE ||
        credential == GSS_C_NO_CREDENTIAL) return -1;
    int result = -1;
    if (gss_inquire_cred(&minor, credential, &name, &life, &usage, NULL) == GSS_S_COMPLETE &&
        life > 0 && life != GSS_C_INDEFINITE && usage == GSS_C_INITIATE && same_name(name, local_name)) result = 0;
    if (name != GSS_C_NO_NAME) gss_release_name(&minor, &name);
    return result;
}
static int initialize(void) {
    const unsigned char *source = take(1);
    uint32_t life, renewable;
    if (!source || *source > 2) return -1;
    mode = *source;
    if (principal(&initiator) || principal(&target) || !data_equals(&target->realm, &initiator->realm) ||
        target->length != 2 || !data_literal(&target->data[0], "vnc") || integer(&life) || integer(&renewable) ||
        !life || life > 7200 || renewable > 7200) return -1;
    ticket_life = life; renew_life = renewable;
    if (mode == 1) {
        const unsigned char *p = take(2);
        if (!p) return -1;
        unsigned size = ((unsigned)p[0] << 8) | p[1]; p = take(size);
        if (!p || !size || size > 1023 || memchr(p, 0, size)) return -1;
        memcpy(password, p, size);
    }
    if (position != input_size || profile_init(NULL, &profile) ||
        relation("dns_lookup_kdc", "false") || relation("dns_lookup_realm", "false") ||
        relation("rdns", "false") || relation("canonicalize", "false") || relation("kdc_timesync", "false") ||
        relation("default_ccache_name", "FILE:/absent") || relation("default_keytab_name", "FILE:/absent") ||
        relation("default_client_keytab_name", "FILE:/absent") || relation("udp_preference_limit", "1") ||
        relation("default_tgs_enctypes", "aes256-cts-hmac-sha1-96 aes128-cts-hmac-sha1-96") ||
        relation("permitted_enctypes", "aes256-cts-hmac-sha1-96 aes128-cts-hmac-sha1-96")) return -1;
    const char *keys[] = {"realms", initiator->realm.data, "kdc", NULL};
    if (profile_add_relation(profile, keys, "127.0.0.1:1") || krb5_init_context_profile(profile, 0, &context)) return -1;
    krb5_set_kdc_send_hook(context, relay, NULL);
    if (krb5_cc_new_unique(context, "MEMORY", NULL, &service_cache) ||
        (mode && krb5_cc_new_unique(context, "MEMORY", NULL, &source_cache)) ||
        import_name(initiator, &local_name) || import_name(target, &target_name)) return -1;
    if ((mode ? acquire() : offline()) || import_credential()) return -1;
    stage = 1;
    return 0;
}
static int source_response(void) {
    krb5_timestamp now;
    if (krb5_timeofday(context, &now)) { native_error = 8; return -1; }
    if (service_end <= now) { native_error = 4; return -1; }
    unsigned char reply[13]; write32(reply, (uint32_t)(service_end - now));
    reply[4] = mode && (initial.ticket_flags & TKT_FLG_RENEWABLE) ? 1 : 0;
    write32(reply + 5, mode ? (uint32_t)initial.times.renew_till : 0);
    write32(reply + 9, (uint32_t)service_end);
    return send_frame(16, reply, sizeof(reply));
}
static int check_context(OM_uint32 *life) {
    OM_uint32 minor, flags;
    gss_OID mechanism = GSS_C_NO_OID;
    gss_name_t local = GSS_C_NO_NAME, peer = GSS_C_NO_NAME;
    int local_init = 0, open = 0, result = -1;
    if (gss_inquire_context(&minor, security, &local, &peer, life, &mechanism, &flags, &local_init, &open) == GSS_S_COMPLETE &&
        local_init && open && *life && *life != GSS_C_INDEFINITE &&
        mechanism && mechanism->length == gss_mech_krb5->length && !memcmp(mechanism->elements, gss_mech_krb5->elements, mechanism->length) &&
        (flags & REQUIRED_FLAGS) == REQUIRED_FLAGS && !(flags & REFUSED_FLAGS) &&
        same_name(local, local_name) && same_name(peer, target_name)) result = 0;
    if (local != GSS_C_NO_NAME) gss_release_name(&minor, &local);
    if (peer != GSS_C_NO_NAME) gss_release_name(&minor, &peer);
    return result;
}
static int gss_step(int first) {
    if ((first && (stage != 1 || input_size)) || (!first && (stage != 2 || !input_size || input_size > 16384))) return -1;
    OM_uint32 minor, flags, lifetime = 0;
    gss_buffer_desc in = {input_size, input}, token = GSS_C_EMPTY_BUFFER;
    OM_uint32 major = gss_init_sec_context(&minor, credential, &security, target_name, gss_mech_krb5,
        REQUIRED_FLAGS, 0, GSS_C_NO_CHANNEL_BINDINGS, first ? GSS_C_NO_BUFFER : &in,
        NULL, &token, &flags, &lifetime);
    int result = -1;
    if ((major != GSS_S_COMPLETE && major != GSS_S_CONTINUE_NEEDED) ||
        token.length > 16384 || (flags & REFUSED_FLAGS)) goto done;
    if (major == GSS_S_COMPLETE && check_context(&lifetime)) goto done;
    stage = major == GSS_S_COMPLETE ? 3 : 2;
    output[0] = stage == 3 ? 1 : 0; write32(output + 1, lifetime);
    output[5] = token.value != NULL ? 1 : 0;
    if (token.length) memcpy(output + 6, token.value, token.length);
    result = send_frame(17, output, token.length + 6);
done:
    erase(output, sizeof(output));
    if (token.value) { erase(token.value, token.length); gss_release_buffer(&minor, &token); }
    return result;
}
static int select_layer(void) {
    if (stage != 3 || !input_size || input_size > 16384) return -1;
    OM_uint32 minor; int confidentiality = 0;
    gss_qop_t qop = GSS_C_QOP_DEFAULT;
    gss_buffer_desc in = {input_size, input}, plain = GSS_C_EMPTY_BUFFER, token = GSS_C_EMPTY_BUFFER;
    int result = -1;
    if (gss_unwrap(&minor, security, &in, &plain, &confidentiality, &qop) != GSS_S_COMPLETE ||
        confidentiality || qop != GSS_C_QOP_DEFAULT || plain.length != 4) goto done;
    unsigned char *offer = plain.value;
    if (!(offer[0] & 1) || (offer[0] & ~7) || (offer[0] == 1 && (offer[1] || offer[2] || offer[3]))) goto done;
    unsigned char selected[] = {1, 0, 0, 0};
    gss_buffer_desc selection = {sizeof(selected), selected};
    if (gss_wrap(&minor, security, 0, GSS_C_QOP_DEFAULT, &selection, &confidentiality, &token) != GSS_S_COMPLETE ||
        confidentiality || !token.length || token.length > 16384) goto done;
    result = send_frame(18, token.value, token.length); stage = 4;
done:
    if (plain.value) { erase(plain.value, plain.length); gss_release_buffer(&minor, &plain); }
    if (token.value) { erase(token.value, token.length); gss_release_buffer(&minor, &token); }
    return result;
}
static void cleanup(void) {
    OM_uint32 minor;
    if (security != GSS_C_NO_CONTEXT) gss_delete_sec_context(&minor, &security, GSS_C_NO_BUFFER);
    if (credential != GSS_C_NO_CREDENTIAL) gss_release_cred(&minor, &credential);
    if (local_name != GSS_C_NO_NAME) gss_release_name(&minor, &local_name);
    if (target_name != GSS_C_NO_NAME) gss_release_name(&minor, &target_name);
    if (service_cache) krb5_cc_destroy(context, service_cache);
    if (source_cache) krb5_cc_destroy(context, source_cache);
    if (context) krb5_free_cred_contents(context, &initial);
    if (initiator) krb5_free_principal(context, initiator);
    if (target) krb5_free_principal(context, target);
    if (context) krb5_free_context(context);
    if (profile) profile_release(profile);
    erase(password, sizeof(password)); erase(input, sizeof(input)); erase(output, sizeof(output));
}
int main(void) {
    /* Fixed non-secret configuration path; the parent supplies an empty environment. */
    if (clearenv() || setenv("KRB5_CONFIG", "/profile.conf", 1) || isolate() || send_frame(0, NULL, 0)) return 1;
    int result = 1;
    for (unsigned operations = 0; operations < 32; ++operations) {
        unsigned kind; ++sequence; native_error = 1; exchanges = 0; exchange_bytes = 0;
        if (receive_frame(&kind, sequence)) break;
        native_error = stage == 0 && kind == 1 ? 1 : 8;
        if (kind == 5 && !input_size) { result = send_frame(19, NULL, 0); break; }
        int rc = -1;
        if (kind == 1 && !stage) rc = initialize() || source_response();
        else if (kind == 2) rc = gss_step(1);
        else if (kind == 3) rc = gss_step(0);
        else if (kind == 4) rc = select_layer();
        else if (kind == 6 && stage == 1 && !input_size) rc = renew() || import_credential() || source_response();
        else if (kind == 7 && stage == 1 && mode && !input_size) rc = acquire() || import_credential() || source_response();
        erase(input, sizeof(input));
        if (rc) { unsigned char error = (unsigned char)native_error; (void)send_frame(255, &error, 1); break; }
    }
    cleanup();
    return result;
}
