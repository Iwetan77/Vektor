/// SessionAuth — on-chain spend caps for Echo session keys.
///
/// Echo delegates autonomous execution to an ephemeral session keypair held by
/// the Vektor server. To bound what that key can ever do, the user signs a
/// transaction (with their MAIN wallet) that creates a shared SessionAuthorization
/// object recording per-tx and per-day USD caps and an expiry. The session key
/// can then build swap PTBs that spend funds held at the session address, and in
/// the SAME programmable transaction it must call `record_execution`, which aborts
/// unless the trade fits inside the caps. Because the call is atomic with the swap,
/// a compromised or buggy server can never exceed the limits the user authorized,
/// and the user can `revoke` at any time.
///
/// Amounts are denominated in USD micros (1 USDC = 1_000_000) so a single cap
/// covers trades in any token — the server converts the trade's notional to USD
/// before calling record_execution.
///
/// Deploy:
///   sui client publish --gas-budget 100000000
/// Then set ECHO_REGISTRY_PACKAGE_ID (server) and VITE_ECHO_PACKAGE_ID (UI) to
/// the published package ID.
module session_auth::session_auth {
    use sui::clock::Clock;
    use sui::event;

    /// One day in milliseconds — the rolling window for the per-day cap.
    const DAY_MS: u64 = 86_400_000;

    // ─── Errors ─────────────────────────────────────────────────────────────
    const ENotSessionKey: u64 = 0;   // caller is not the authorized session address
    const ERevoked:       u64 = 1;   // authorization has been revoked by the owner
    const EExpired:       u64 = 2;   // authorization is past its expiry
    const ETxLimit:       u64 = 3;   // single-trade notional exceeds max_amount_per_tx
    const EDayLimit:      u64 = 4;   // would exceed the rolling 24h max_amount_per_day
    const ENotOwner:      u64 = 5;   // only the creating wallet may revoke

    // ─── Object ─────────────────────────────────────────────────────────────

    /// Shared authorization object. Shared (not owned) so the session key can
    /// mutate `spent_today` when recording an execution.
    public struct SessionAuthorization has key {
        id:                 UID,
        /// User's main wallet — the only address allowed to revoke.
        owner:              address,
        /// Ephemeral session key address — the only address allowed to execute.
        session_address:    address,
        /// Per-transaction notional cap, USD micros.
        max_amount_per_tx:  u64,
        /// Rolling 24h notional cap, USD micros.
        max_amount_per_day: u64,
        /// Optional protocol allow-list (opaque bytes; empty = all allowed).
        allowed_protocols:  vector<u8>,
        /// Expiry, epoch ms. After this the key is inert.
        expires_at:         u64,
        is_revoked:         bool,
        /// USD micros spent inside the current rolling day.
        spent_today:        u64,
        /// Start of the current rolling-day window, epoch ms.
        day_start_ms:       u64,
    }

    // ─── Events ─────────────────────────────────────────────────────────────

    public struct SessionCreated has copy, drop {
        auth_id:         address,
        owner:           address,
        session_address: address,
        expires_at:      u64,
    }

    public struct SessionExecuted has copy, drop {
        auth_id:     address,
        amount_usd:  u64,
        spent_today: u64,
        timestamp_ms: u64,
    }

    public struct SessionRevoked has copy, drop {
        auth_id: address,
        owner:   address,
    }

    // ─── Create ─────────────────────────────────────────────────────────────

    /// Create and share a SessionAuthorization. Signed by the user's main wallet,
    /// so `ctx.sender()` becomes the owner. Argument order matches
    /// buildSessionAuthPtb() in src/echo/session.ts.
    public fun create_and_share(
        session_address:    address,
        max_amount_per_tx:  u64,
        max_amount_per_day: u64,
        allowed_protocols:  vector<u8>,
        expires_at:         u64,
        clock:              &Clock,
        ctx:                &mut TxContext,
    ) {
        let auth = SessionAuthorization {
            id:                 object::new(ctx),
            owner:              ctx.sender(),
            session_address,
            max_amount_per_tx,
            max_amount_per_day,
            allowed_protocols,
            expires_at,
            is_revoked:         false,
            spent_today:        0,
            day_start_ms:       clock.timestamp_ms(),
        };
        event::emit(SessionCreated {
            auth_id:         object::uid_to_address(&auth.id),
            owner:           auth.owner,
            session_address: auth.session_address,
            expires_at:      auth.expires_at,
        });
        transfer::share_object(auth);
    }

    // ─── Execute (called atomically with the swap, by the session key) ───────

    /// Record a trade against the caps. MUST be called in the same PTB as the
    /// swap, signed by the session key. Aborts unless the trade is authorized and
    /// within both the per-tx and rolling-day limits; rolls the day window over
    /// when 24h have elapsed.
    public fun record_execution(
        auth:              &mut SessionAuthorization,
        amount_usd_micros: u64,
        clock:             &Clock,
        ctx:               &mut TxContext,
    ) {
        assert!(ctx.sender() == auth.session_address, ENotSessionKey);
        assert!(!auth.is_revoked, ERevoked);

        let now = clock.timestamp_ms();
        assert!(now < auth.expires_at, EExpired);
        assert!(amount_usd_micros <= auth.max_amount_per_tx, ETxLimit);

        // Roll the daily window if a full day has elapsed since it started.
        if (now - auth.day_start_ms >= DAY_MS) {
            auth.day_start_ms = now;
            auth.spent_today  = 0;
        };

        assert!(auth.spent_today + amount_usd_micros <= auth.max_amount_per_day, EDayLimit);
        auth.spent_today = auth.spent_today + amount_usd_micros;

        event::emit(SessionExecuted {
            auth_id:      object::uid_to_address(&auth.id),
            amount_usd:   amount_usd_micros,
            spent_today:  auth.spent_today,
            timestamp_ms: now,
        });
    }

    // ─── Revoke ─────────────────────────────────────────────────────────────

    /// Permanently disable the authorization. Only the owner (main wallet) may
    /// call. After this, record_execution always aborts.
    public fun revoke(auth: &mut SessionAuthorization, ctx: &mut TxContext) {
        assert!(ctx.sender() == auth.owner, ENotOwner);
        auth.is_revoked = true;
        event::emit(SessionRevoked {
            auth_id: object::uid_to_address(&auth.id),
            owner:   auth.owner,
        });
    }

    // ─── Views ──────────────────────────────────────────────────────────────

    public fun is_revoked(auth: &SessionAuthorization): bool { auth.is_revoked }
    public fun expires_at(auth: &SessionAuthorization): u64 { auth.expires_at }
    public fun max_amount_per_tx(auth: &SessionAuthorization): u64 { auth.max_amount_per_tx }
    public fun max_amount_per_day(auth: &SessionAuthorization): u64 { auth.max_amount_per_day }
    public fun spent_today(auth: &SessionAuthorization): u64 { auth.spent_today }

    // ─── Tests ──────────────────────────────────────────────────────────────

    #[test_only]
    use sui::clock;
    #[test_only]
    use sui::test_scenario as ts;

    #[test_only]
    const OWNER:   address = @0xA11CE;
    #[test_only]
    const SESSION: address = @0x5E5510;

    #[test]
    fun create_then_execute_within_limits() {
        let mut scenario = ts::begin(OWNER);
        let clk = clock::create_for_testing(scenario.ctx());

        // Owner creates the authorization: $2k per tx, $5k per day.
        create_and_share(SESSION, 2_000_000_000, 5_000_000_000, vector[], 10_000_000_000, &clk, scenario.ctx());
        scenario.next_tx(SESSION);

        // Session key records two trades, each under per-tx and summing under daily.
        let mut auth = scenario.take_shared<SessionAuthorization>();
        record_execution(&mut auth, 1_000_000_000, &clk, scenario.ctx());
        record_execution(&mut auth, 2_000_000_000, &clk, scenario.ctx());
        assert!(spent_today(&auth) == 3_000_000_000, 0);

        ts::return_shared(auth);
        clk.destroy_for_testing();
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = ETxLimit)]
    fun rejects_over_per_tx() {
        let mut scenario = ts::begin(OWNER);
        let clk = clock::create_for_testing(scenario.ctx());
        create_and_share(SESSION, 1_000_000_000, 5_000_000_000, vector[], 10_000_000_000, &clk, scenario.ctx());
        scenario.next_tx(SESSION);
        let mut auth = scenario.take_shared<SessionAuthorization>();
        record_execution(&mut auth, 1_000_000_001, &clk, scenario.ctx()); // 1 over per-tx cap
        ts::return_shared(auth);
        clk.destroy_for_testing();
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = EDayLimit)]
    fun rejects_over_daily() {
        let mut scenario = ts::begin(OWNER);
        let clk = clock::create_for_testing(scenario.ctx());
        create_and_share(SESSION, 5_000_000_000, 5_000_000_000, vector[], 10_000_000_000, &clk, scenario.ctx());
        scenario.next_tx(SESSION);
        let mut auth = scenario.take_shared<SessionAuthorization>();
        record_execution(&mut auth, 3_000_000_000, &clk, scenario.ctx());
        record_execution(&mut auth, 3_000_000_000, &clk, scenario.ctx()); // 6B > 5B daily
        ts::return_shared(auth);
        clk.destroy_for_testing();
        scenario.end();
    }

    #[test]
    fun daily_window_resets_after_24h() {
        let mut scenario = ts::begin(OWNER);
        let mut clk = clock::create_for_testing(scenario.ctx());
        create_and_share(SESSION, 5_000_000_000, 5_000_000_000, vector[], 100_000_000_000, &clk, scenario.ctx());
        scenario.next_tx(SESSION);
        let mut auth = scenario.take_shared<SessionAuthorization>();
        record_execution(&mut auth, 5_000_000_000, &clk, scenario.ctx()); // fills the day
        clk.increment_for_testing(DAY_MS); // advance 24h
        record_execution(&mut auth, 5_000_000_000, &clk, scenario.ctx()); // fresh window — ok
        assert!(spent_today(&auth) == 5_000_000_000, 0);
        ts::return_shared(auth);
        clk.destroy_for_testing();
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = ENotSessionKey)]
    fun rejects_wrong_caller() {
        let mut scenario = ts::begin(OWNER);
        let clk = clock::create_for_testing(scenario.ctx());
        create_and_share(SESSION, 5_000_000_000, 5_000_000_000, vector[], 10_000_000_000, &clk, scenario.ctx());
        scenario.next_tx(@0xBAD); // not the session key
        let mut auth = scenario.take_shared<SessionAuthorization>();
        record_execution(&mut auth, 1_000_000, &clk, scenario.ctx());
        ts::return_shared(auth);
        clk.destroy_for_testing();
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = ERevoked)]
    fun rejects_after_revoke() {
        let mut scenario = ts::begin(OWNER);
        let clk = clock::create_for_testing(scenario.ctx());
        create_and_share(SESSION, 5_000_000_000, 5_000_000_000, vector[], 10_000_000_000, &clk, scenario.ctx());

        // Owner revokes.
        scenario.next_tx(OWNER);
        let mut auth = scenario.take_shared<SessionAuthorization>();
        revoke(&mut auth, scenario.ctx());
        ts::return_shared(auth);

        // Session key now blocked.
        scenario.next_tx(SESSION);
        let mut auth2 = scenario.take_shared<SessionAuthorization>();
        record_execution(&mut auth2, 1_000_000, &clk, scenario.ctx());
        ts::return_shared(auth2);
        clk.destroy_for_testing();
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = ENotOwner)]
    fun rejects_non_owner_revoke() {
        let mut scenario = ts::begin(OWNER);
        let clk = clock::create_for_testing(scenario.ctx());
        create_and_share(SESSION, 5_000_000_000, 5_000_000_000, vector[], 10_000_000_000, &clk, scenario.ctx());
        scenario.next_tx(SESSION); // session key is not the owner
        let mut auth = scenario.take_shared<SessionAuthorization>();
        revoke(&mut auth, scenario.ctx());
        ts::return_shared(auth);
        clk.destroy_for_testing();
        scenario.end();
    }
}
