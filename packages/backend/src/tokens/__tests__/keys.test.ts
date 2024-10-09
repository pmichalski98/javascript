import sinon from 'sinon';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TokenVerificationError, TokenVerificationErrorAction, TokenVerificationErrorReason } from '../../errors';
import {
  mockJwks,
  mockJwtPayload,
  mockPEMJwk,
  mockPEMJwtKey,
  mockPEMKey,
  mockRsaJwk,
  mockRsaJwkKid,
} from '../../fixtures';
import runtime from '../../runtime';
import { jsonError, jsonOk } from '../../util/testUtils';
import { loadClerkJWKFromLocal, loadClerkJWKFromRemote } from '../keys';

describe('tokens.loadClerkJWKFromLocal(localKey)', () => {
  it('throws an error if no key has been provided', () => {
    expect(() => loadClerkJWKFromLocal()).toThrow(
      new TokenVerificationError({
        action: TokenVerificationErrorAction.SetClerkJWTKey,
        message: 'Missing local JWK.',
        reason: TokenVerificationErrorReason.LocalJWKMissing,
      }),
    );
  });

  it('loads the local key', () => {
    const jwk = loadClerkJWKFromLocal(mockPEMKey);
    expect(jwk).toMatchObject(mockPEMJwk);
  });

  it('loads the local key in PEM format', () => {
    const jwk = loadClerkJWKFromLocal(mockPEMJwtKey);
    expect(jwk).toMatchObject(mockPEMJwk);
  });
});

describe('tokens.loadClerkJWKFromRemote(options)', () => {
  let fakeClock;
  let fakeFetch;

  beforeEach(() => {
    fakeClock = sinon.useFakeTimers(new Date(mockJwtPayload.iat * 1000).getTime());
    fakeFetch = sinon.stub(runtime, 'fetch');
  });

  afterEach(() => {
    fakeClock.restore();
    fakeFetch.restore();
    sinon.restore();
  });

  it('loads JWKS from Backend API when secretKey is provided', async () => {
    fakeFetch.onCall(0).returns(jsonOk(mockJwks));
    const jwk = await loadClerkJWKFromRemote({
      secretKey: 'sk_test_deadbeef',
      kid: mockRsaJwkKid,
      skipJwksCache: true,
    });

    expect(
      fakeFetch.calledOnceWith('https://api.clerk.com/v1/jwks', {
        method: 'GET',
        headers: {
          Authorization: 'Bearer deadbeef',
          'Content-Type': 'application/json',
          'User-Agent': '@clerk/backend@0.0.0-test',
        },
      }),
    ).toBe(true);
    expect(jwk).toMatchObject(mockRsaJwk);
  });

  it('loads JWKS from Backend API using the provided apiUrl', async () => {
    fakeFetch.onCall(0).returns(jsonOk(mockJwks));
    const jwk = await loadClerkJWKFromRemote({
      secretKey: 'sk_test_deadbeef',
      apiUrl: 'https://api.clerk.test',
      kid: mockRsaJwkKid,
      skipJwksCache: true,
    });

    expect(
      fakeFetch.calledOnceWith('https://api.clerk.test/v1/jwks', {
        method: 'GET',
        headers: {
          Authorization: 'Bearer sk_test_deadbeef',
          'Content-Type': 'application/json',
          'User-Agent': '@clerk/backend@0.0.0-test',
        },
      }),
    ).toBe(true);
    expect(jwk).toMatchObject(mockRsaJwk);
  });

  it('caches JWK by kid', async () => {
    fakeFetch.onCall(0).returns(jsonOk(mockJwks));
    let jwk = await loadClerkJWKFromRemote({
      secretKey: 'deadbeef',
      kid: mockRsaJwkKid,
      skipJwksCache: true,
    });
    expect(jwk).toMatchObject(mockRsaJwk);
    jwk = await loadClerkJWKFromRemote({
      secretKey: 'deadbeef',
      kid: mockRsaJwkKid,
    });
    expect(jwk).toMatchObject(mockRsaJwk);
  });

  it('retries five times with exponential back-off policy to fetch JWKS before it fails', async () => {
    fakeClock.restore();
    fakeFetch.onCall(0).returns(jsonError('something awful happened', 503));
    fakeFetch.onCall(1).returns(jsonError('server error'));
    fakeFetch.onCall(2).returns(jsonError('server error'));
    fakeFetch.onCall(3).returns(jsonError('server error'));
    fakeFetch.onCall(4).returns(jsonError('Connection to the origin web server failed', 542));

    try {
      await loadClerkJWKFromRemote({
        secretKey: 'deadbeef',
        kid: 'ins_whatever',
        skipJwksCache: true,
      });
      expect(false).toBe(true);
    } catch (err) {
      if (err instanceof Error) {
        expect(err).toMatchObject({
          reason: 'jwk-remote-failed-to-load',
          action: 'Contact support@clerk.com',
        });
      } else {
        expect(false).toBe(true);
      }
    }
    expect(fakeFetch.callCount).toBe(5);
  });

  it('throws an error when JWKS can not be fetched from Backend or Frontend API', async () => {
    try {
      await loadClerkJWKFromRemote({
        kid: 'ins_whatever',
        skipJwksCache: true,
      });
      expect(false).toBe(true);
    } catch (err) {
      if (err instanceof Error) {
        expect(err).toMatchObject({
          reason: 'jwk-remote-failed-to-load',
          action: 'Contact support@clerk.com',
        });
      } else {
        expect(false).toBe(true);
      }
    }
  });

  it('throws an error when no JWK matches the provided kid', async () => {
    fakeFetch.onCall(0).returns(jsonOk(mockJwks));
    const kid = 'ins_whatever';

    try {
      await loadClerkJWKFromRemote({
        secretKey: 'deadbeef',
        kid,
      });
      expect(false).toBe(true);
    } catch (err) {
      if (err instanceof Error) {
        expect(err).toMatchObject({
          reason: 'jwk-kid-mismatch',
          action:
            'Go to your Dashboard and validate your secret and public keys are correct. Contact support@clerk.com if the issue persists.',
        });
        expect(err).toMatchObject({
          message: `Unable to find a signing key in JWKS that matches the kid='${kid}' of the provided session token. Please make sure that the __session cookie or the HTTP authorization header contain a Clerk-generated session JWT. The following kid is available: ${mockRsaJwkKid}, local`,
        });
      } else {
        expect(false).toBe(true);
      }
    }
  });

  it('cache TTLs do not conflict', async () => {
    fakeClock.runAll();

    fakeFetch.onCall(0).returns(jsonOk(mockJwks));
    let jwk = await loadClerkJWKFromRemote({
      secretKey: 'deadbeef',
      kid: mockRsaJwkKid,
      skipJwksCache: true,
    });
    expect(jwk).toMatchObject(mockRsaJwk);

    fakeClock.tick(60 * 60 * 1000 - 5);

    fakeFetch.onCall(1).returns(jsonOk(mockJwks));
    jwk = await loadClerkJWKFromRemote({
      secretKey: 'deadbeef',
      kid: mockRsaJwkKid,
    });
    expect(jwk).toMatchObject(mockRsaJwk);

    fakeClock.next();

    jwk = await loadClerkJWKFromRemote({
      secretKey: 'deadbeef',
      kid: mockRsaJwkKid,
    });
    expect(jwk).toMatchObject(mockRsaJwk);
  });
});
