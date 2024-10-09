import sinon from 'sinon';
import { afterEach, describe, expect, it } from 'vitest';

// @ts-ignore
import userJson from '../../fixtures/user.json';
import runtime from '../../runtime';
import { jsonError, jsonNotOk, jsonOk, jsonPaginatedOk } from '../../util/testUtils';
import { createBackendApiClient } from '../factory';

describe('api.client', () => {
  const apiClient = createBackendApiClient({
    apiUrl: 'https://api.clerk.test',
    secretKey: 'deadbeef',
  });

  let fakeFetch;

  afterEach(() => {
    fakeFetch?.restore();
  });

  it('executes a successful backend API request for a single resource and parses the response', async () => {
    fakeFetch = sinon.stub(runtime, 'fetch');
    fakeFetch.onCall(0).returns(jsonOk(userJson));

    const response = await apiClient.users.getUser('user_deadbeef');

    expect(response.firstName).toBe('John');
    expect(response.lastName).toBe('Doe');
    expect(response.emailAddresses[0].emailAddress).toBe('john.doe@clerk.test');
    expect(response.phoneNumbers[0].phoneNumber).toBe('+311-555-2368');
    expect(response.externalAccounts[0].emailAddress).toBe('john.doe@clerk.test');
    expect(response.publicMetadata.zodiac_sign).toBe('leo');

    expect(
      fakeFetch.calledOnceWith('https://api.clerk.test/v1/users/user_deadbeef', {
        method: 'GET',
        headers: {
          Authorization: 'Bearer deadbeef',
          'Content-Type': 'application/json',
          'User-Agent': '@clerk/backend@0.0.0-test',
        },
      }),
    ).toBe(true);
  });

  it('executes 2 backend API request for users.getUserList()', async () => {
    fakeFetch = sinon.stub(runtime, 'fetch');
    fakeFetch.onCall(0).returns(jsonOk([userJson]));
    fakeFetch.onCall(1).returns(jsonOk({ object: 'total_count', total_count: 2 }));

    const { data, totalCount } = await apiClient.users.getUserList({
      offset: 2,
      limit: 5,
      userId: ['user_cafebabe'],
    });

    expect(data[0].firstName).toBe('John');
    expect(data[0].id).toBe('user_cafebabe');
    expect(data.length).toBe(1);
    expect(totalCount).toBe(2);

    expect(
      fakeFetch.calledWith('https://api.clerk.test/v1/users?offset=2&limit=5&user_id=user_cafebabe', {
        method: 'GET',
        headers: {
          Authorization: 'Bearer deadbeef',
          'Content-Type': 'application/json',
          'User-Agent': '@clerk/backend@0.0.0-test',
        },
      }),
    ).toBe(true);
    expect(
      fakeFetch.calledWith('https://api.clerk.test/v1/users/count?user_id=user_cafebabe', {
        method: 'GET',
        headers: {
          Authorization: 'Bearer deadbeef',
          'Content-Type': 'application/json',
          'User-Agent': '@clerk/backend@0.0.0-test',
        },
      }),
    ).toBe(true);
  });

  it('executes a successful backend API request for a paginated response', async () => {
    fakeFetch = sinon.stub(runtime, 'fetch');
    fakeFetch.onCall(0).returns(jsonPaginatedOk([{ id: '1' }], 3));

    const { data: response, totalCount } = await apiClient.users.getOrganizationMembershipList({
      offset: 2,
      limit: 5,
      userId: 'user_123',
    });

    expect(response[0].id).toBe('1');
    expect(totalCount).toBe(3);
    expect(response.length).toBe(1);
  });

  it('executes a successful backend API request to create a new resource', async () => {
    fakeFetch = sinon.stub(runtime, 'fetch');
    fakeFetch.onCall(0).returns(jsonOk(userJson));

    const response = await apiClient.users.createUser({
      firstName: 'John',
      lastName: 'Doe',
      publicMetadata: {
        star_sign: 'Leon',
      },
    });

    expect(response.firstName).toBe('John');

    expect(
      fakeFetch.calledOnceWith('https://api.clerk.test/v1/users', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer deadbeef',
          'Content-Type': 'application/json',
          'User-Agent': '@clerk/backend@0.0.0-test',
        },
        body: JSON.stringify({
          first_name: 'John',
          last_name: 'Doe',
          public_metadata: {
            star_sign: 'Leon',
          },
        }),
      }),
    ).toBe(true);
  });

  it('executes a failed backend API request and parses the error response', async () => {
    const mockErrorPayload = {
      code: 'whatever_error',
      message: 'whatever error',
      long_message: 'some long message',
      meta: { param_name: 'some param' },
    };
    const traceId = 'trace_id_123';
    fakeFetch = sinon.stub(runtime, 'fetch');
    fakeFetch.onCall(0).returns(jsonNotOk({ errors: [mockErrorPayload], clerk_trace_id: traceId }));

    const errResponse = await apiClient.users.getUser('user_deadbeef').catch(err => err);

    expect(errResponse.clerkTraceId).toBe(traceId);
    expect(errResponse.status).toBe(422);
    expect(errResponse.errors[0].code).toBe('whatever_error');
    expect(errResponse.errors[0].message).toBe('whatever error');
    expect(errResponse.errors[0].longMessage).toBe('some long message');
    expect(errResponse.errors[0].meta.paramName).toBe('some param');

    expect(
      fakeFetch.calledOnceWith('https://api.clerk.test/v1/users/user_deadbeef', {
        method: 'GET',
        headers: {
          Authorization: 'Bearer deadbeef',
          'Content-Type': 'application/json',
          'User-Agent': '@clerk/backend@0.0.0-test',
        },
      }),
    ).toBe(true);
  });

  it('executes a failed backend API request and include cf ray id when trace not present', async () => {
    fakeFetch = sinon.stub(runtime, 'fetch');
    fakeFetch.onCall(0).returns(jsonError({ errors: [] }));

    const errResponse = await apiClient.users.getUser('user_deadbeef').catch(err => err);

    expect(errResponse.status).toBe(500);
    expect(errResponse.clerkTraceId).toBe('mock_cf_ray');

    expect(
      fakeFetch.calledOnceWith('https://api.clerk.test/v1/users/user_deadbeef', {
        method: 'GET',
        headers: {
          Authorization: 'Bearer deadbeef',
          'Content-Type': 'application/json',
          'User-Agent': '@clerk/backend@0.0.0-test',
        },
      }),
    ).toBe(true);
  });

  it('executes a successful backend API request to delete a domain', async () => {
    const domainId = 'dmn_123';
    const fakeResponse = {
      object: 'domain',
      id: domainId,
      deleted: true,
    };

    fakeFetch = sinon.stub(runtime, 'fetch');
    fakeFetch.onCall(0).returns(jsonOk(fakeResponse, 204));

    await apiClient.domains.deleteDomain(domainId);

    expect(
      fakeFetch.calledOnceWith(`https://api.clerk.test/v1/domains/${domainId}`, {
        method: 'DELETE',
        headers: {
          Authorization: 'Bearer deadbeef',
          'Content-Type': 'application/json',
          'User-Agent': '@clerk/backend@0.0.0-test',
        },
      }),
    ).toBe(true);
  });

  it('successfully retrieves user access tokens from backend API for a specific provider', async () => {
    const fakeResponse = {
      data: [
        {
          external_account_id: 'eac_2dYS7stz9bgxQsSRvNqEAHhuxvW',
          object: 'oauth_access_token',
          token: '<token>',
          provider: 'oauth_google',
          public_metadata: {},
          label: null,
          scopes: ['email', 'profile'],
        },
      ],
      total_count: 1,
    };

    fakeFetch = sinon.stub(runtime, 'fetch');
    fakeFetch.onCall(0).returns(jsonOk(fakeResponse));

    const response = await apiClient.users.getUserOauthAccessToken('user_deadbeef', 'oauth_google');

    expect(response.data[0].externalAccountId).toBe('eac_2dYS7stz9bgxQsSRvNqEAHhuxvW');
    expect(response.data[0].provider).toBe('oauth_google');
    expect(response.data[0].token).toBe('<token>');
    expect(response.data[0].scopes).toEqual(['email', 'profile']);

    expect(
      fakeFetch.calledOnceWith(
        'https://api.clerk.test/v1/users/user_deadbeef/oauth_access_tokens/oauth_google?paginated=true',
        {
          method: 'GET',
          headers: {
            Authorization: 'Bearer deadbeef',
            'Content-Type': 'application/json',
            'User-Agent': '@clerk/backend@0.0.0-test',
          },
        },
      ),
    ).toBe(true);
  });
});
