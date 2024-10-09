import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockJwks, mockJwt, mockJwtPayload } from '../../fixtures';
import { jsonOk } from '../../util/testUtils';
import { verifyToken } from '../verify';

vi.useFakeTimers();
vi.setSystemTime(new Date(mockJwtPayload.iat * 1000).getTime());

describe('tokens.verify(token, options)', () => {
  afterEach(() => {});
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonOk(mockJwks)));
  });

  it('verifies the provided session JWT', async () => {
    const { data } = await verifyToken(mockJwt, {
      apiUrl: 'https://api.clerk.test',
      secretKey: 'a-valid-key',
      authorizedParties: ['https://accounts.inspired.puma-74.lcl.dev'],
      skipJwksCache: true,
    });

    expect(data).toEqual(mockJwtPayload);
    // expect(fakeFetch.calledOnce).toBe(true);
  });

  it('verifies the token by fetching the JWKs from Backend API when secretKey is provided', async () => {
    const { data } = await verifyToken(mockJwt, {
      secretKey: 'a-valid-key',
      authorizedParties: ['https://accounts.inspired.puma-74.lcl.dev'],
      skipJwksCache: true,
    });

    // expect(
    //   fakeFetch.calledOnceWith('https://clerk.inspired.puma-74.lcl.dev/v1/jwks', {
    //     method: 'GET',
    //     headers: {
    //       Authorization: 'Bearer a-valid-key',
    //       'Content-Type': 'application/json',
    //       'User-Agent': '@clerk/backend@0.0.0-test',
    //     },
    //   }),
    // ).toBe(true);
    expect(data).toEqual(mockJwtPayload);
  });

  it('returns an error if the JWT is invalid', async () => {
    const invalidJwt = 'invalid.jwt.token';

    try {
      const { errors } = await verifyToken(invalidJwt, {
        secretKey: 'a-valid-key',
        authorizedParties: ['https://accounts.inspired.puma-74.lcl.dev'],
        skipJwksCache: true,
      });
    } catch (e) {
      console.log(e);
    }

    expect(errors).toBeDefined();
    expect(errors?.length).toBeGreaterThan(0);
  });

  it('returns an error if the JWK cannot be resolved', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

    const { errors } = await verifyToken(mockJwt, {
      secretKey: 'a-valid-key',
      authorizedParties: ['https://accounts.inspired.puma-74.lcl.dev'],
      skipJwksCache: true,
    });

    expect(errors).toBeDefined();
    expect(errors?.length).toBeGreaterThan(0);
    expect(errors?.[0]?.message).toBe('Failed to resolve JWK during verification.');
  });

  it('verifies the token using a local JWT key', async () => {
    const res = await verifyToken(mockJwt, {
      jwtKey: 'a-local-jwt-key',
      authorizedParties: ['https://accounts.inspired.puma-74.lcl.dev'],
      skipJwksCache: true,
    });

    console.log(res);

    expect(res).toEqual(mockJwtPayload);
  });
});
