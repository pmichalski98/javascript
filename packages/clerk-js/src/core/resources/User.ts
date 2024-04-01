import type {
  BackupCodeJSON,
  BackupCodeResource,
  BillingPlanJSON,
  BillingPlanResource,
  ClerkPaginatedResponse,
  CreateBillingPortalSessionParams,
  CreateEmailAddressParams,
  CreateExternalAccountParams,
  CreatePhoneNumberParams,
  CreateWeb3WalletParams,
  DeletedObjectJSON,
  DeletedObjectResource,
  EmailAddressResource,
  ExternalAccountJSON,
  ExternalAccountResource,
  GetOrganizationMemberships,
  GetUserOrganizationInvitationsParams,
  GetUserOrganizationSuggestionsParams,
  ImageResource,
  OrganizationMembershipResource,
  PasskeyResource,
  PhoneNumberResource,
  RemoveUserPasswordParams,
  SamlAccountResource,
  SetProfileImageParams,
  TOTPJSON,
  TOTPResource,
  UpdateUserParams,
  UpdateUserPasswordParams,
  UserJSON,
  UserResource,
  VerifyTOTPParams,
  Web3WalletResource,
} from '@clerk/types';

import { unixEpochToDate } from '../../utils/date';
import { normalizeUnsafeMetadata } from '../../utils/resourceParams';
import { getFullName } from '../../utils/user';
import { BackupCode } from './BackupCode';
import { BillingPlan } from './Billing';
import {
  BaseResource,
  DeletedObject,
  EmailAddress,
  ExternalAccount,
  Image,
  OrganizationMembership,
  OrganizationSuggestion,
  Passkey,
  PhoneNumber,
  SamlAccount,
  SessionWithActivities,
  TOTP,
  UserOrganizationInvitation,
  Web3Wallet,
} from './internal';

export class User extends BaseResource implements UserResource {
  pathRoot = '/me';

  id = '';
  externalId: string | null = null;
  username: string | null = null;
  emailAddresses: EmailAddressResource[] = [];
  phoneNumbers: PhoneNumberResource[] = [];
  web3Wallets: Web3WalletResource[] = [];
  externalAccounts: ExternalAccountResource[] = [];
  // TODO-PASSKEY: Remove in the next minor
  __experimental_passkeys: PasskeyResource[] = [];
  passkeys: PasskeyResource[] = [];

  samlAccounts: SamlAccountResource[] = [];

  organizationMemberships: OrganizationMembershipResource[] = [];
  passwordEnabled = false;
  firstName: string | null = null;
  lastName: string | null = null;
  fullName: string | null = null;
  primaryEmailAddressId: string | null = null;
  primaryEmailAddress: EmailAddressResource | null = null;
  primaryPhoneNumberId: string | null = null;
  primaryPhoneNumber: PhoneNumberResource | null = null;
  primaryWeb3WalletId: string | null = null;
  primaryWeb3Wallet: Web3WalletResource | null = null;
  imageUrl = '';
  hasImage = false;
  twoFactorEnabled = false;
  totpEnabled = false;
  backupCodeEnabled = false;
  publicMetadata: UserPublicMetadata = {};
  unsafeMetadata: UserUnsafeMetadata = {};
  createOrganizationEnabled = false;
  deleteSelfEnabled = false;
  lastSignInAt: Date | null = null;
  updatedAt: Date | null = null;
  createdAt: Date | null = null;

  private cachedSessionsWithActivities: SessionWithActivities[] | null = null;

  static isUserResource(resource: unknown): resource is User {
    return !!resource && resource instanceof User;
  }

  constructor(data: UserJSON) {
    super();
    this.fromJSON(data);
  }

  protected path(): string {
    return this.pathRoot;
  }

  isPrimaryIdentification = (ident: EmailAddressResource | PhoneNumberResource | Web3WalletResource): boolean => {
    switch (ident.constructor) {
      case EmailAddress:
        return this.primaryEmailAddressId === ident.id;
      case PhoneNumber:
        return this.primaryPhoneNumberId === ident.id;
      case Web3Wallet:
        return this.primaryWeb3WalletId === ident.id;
      default:
        return false;
    }
  };

  createEmailAddress = (params: CreateEmailAddressParams): Promise<EmailAddressResource> => {
    const { email } = params || {};
    return new EmailAddress(
      {
        email_address: email,
      },
      this.path() + '/email_addresses/',
    ).create();
  };

  /**
   * @experimental
   * This method is experimental, avoid using this in production applications
   */
  __experimental_createPasskey = (): Promise<PasskeyResource> => {
    return Passkey.registerPasskey();
  };

  createPasskey = (): Promise<PasskeyResource> => {
    return Passkey.registerPasskey();
  };

  createPhoneNumber = (params: CreatePhoneNumberParams): Promise<PhoneNumberResource> => {
    const { phoneNumber } = params || {};
    return new PhoneNumber(
      {
        phone_number: phoneNumber,
      },
      this.path() + '/phone_numbers/',
    ).create();
  };

  createWeb3Wallet = (params: CreateWeb3WalletParams): Promise<Web3WalletResource> => {
    const { web3Wallet } = params || {};
    return new Web3Wallet(
      {
        web3_wallet: web3Wallet,
      },
      this.path() + '/web3_wallets/',
    ).create();
  };

  createExternalAccount = async (params: CreateExternalAccountParams): Promise<ExternalAccountResource> => {
    const { strategy, redirectUrl, additionalScopes } = params || {};

    const json = (
      await BaseResource._fetch<ExternalAccountJSON>({
        path: '/me/external_accounts',
        method: 'POST',
        body: {
          strategy,
          redirect_url: redirectUrl,
          additional_scope: additionalScopes,
        } as any,
      })
    )?.response as unknown as ExternalAccountJSON;

    return new ExternalAccount(json, this.path() + '/external_accounts');
  };

  createTOTP = async (): Promise<TOTPResource> => {
    const json = (
      await BaseResource._fetch<TOTPJSON>({
        path: '/me/totp',
        method: 'POST',
      })
    )?.response as unknown as TOTPJSON;

    return new TOTP(json);
  };

  verifyTOTP = async ({ code }: VerifyTOTPParams): Promise<TOTPResource> => {
    const json = (
      await BaseResource._fetch<ExternalAccountJSON>({
        path: '/me/totp/attempt_verification',
        method: 'POST',
        body: { code } as any,
      })
    )?.response as unknown as TOTPJSON;

    return new TOTP(json);
  };

  disableTOTP = async (): Promise<DeletedObjectResource> => {
    const json = (
      await BaseResource._fetch<DeletedObjectJSON>({
        path: '/me/totp',
        method: 'DELETE',
      })
    )?.response as unknown as DeletedObjectJSON;

    return new DeletedObject(json);
  };

  createBackupCode = async (): Promise<BackupCodeResource> => {
    const json = (
      await BaseResource._fetch<BackupCodeJSON>({
        path: this.path() + '/backup_codes/',
        method: 'POST',
      })
    )?.response as unknown as BackupCodeJSON;

    return new BackupCode(json);
  };

  update = (params: UpdateUserParams): Promise<UserResource> => {
    return this._basePatch({
      body: normalizeUnsafeMetadata(params),
    });
  };

  updatePassword = (params: UpdateUserPasswordParams): Promise<UserResource> => {
    return this._basePost({
      body: params,
      path: `${this.path()}/change_password`,
    });
  };

  removePassword = (params: RemoveUserPasswordParams): Promise<UserResource> => {
    return this._basePost({
      body: params,
      path: `${this.path()}/remove_password`,
    });
  };

  delete = (): Promise<void> => {
    return this._baseDelete({ path: '/me' });
  };

  getSessions = async (): Promise<SessionWithActivities[]> => {
    if (this.cachedSessionsWithActivities) {
      return this.cachedSessionsWithActivities;
    }
    const res = await SessionWithActivities.retrieve();
    this.cachedSessionsWithActivities = res;
    return res;
  };

  setProfileImage = (params: SetProfileImageParams): Promise<ImageResource> => {
    const { file } = params || {};

    if (file === null) {
      return Image.delete(`${this.path()}/profile_image`);
    }
    return Image.create(`${this.path()}/profile_image`, {
      file,
    });
  };

  getOrganizationInvitations = (params?: GetUserOrganizationInvitationsParams) => {
    return UserOrganizationInvitation.retrieve(params);
  };

  getOrganizationSuggestions = (params?: GetUserOrganizationSuggestionsParams) => {
    return OrganizationSuggestion.retrieve(params);
  };

  getOrganizationMemberships: GetOrganizationMemberships = retrieveMembership =>
    OrganizationMembership.retrieve(retrieveMembership);

  leaveOrganization = async (organizationId: string): Promise<DeletedObjectResource> => {
    const json = (
      await BaseResource._fetch<DeletedObjectJSON>({
        path: `${this.path()}/organization_memberships/${organizationId}`,
        method: 'DELETE',
      })
    )?.response as unknown as DeletedObjectJSON;

    return new DeletedObject(json);
  };

  getAvailablePlans = async (): Promise<ClerkPaginatedResponse<BillingPlanResource>> => {
    return await BaseResource._fetch({
      path: `${this.path()}/billing/available_plans`,
      method: 'GET',
    }).then(res => {
      const { data: requests, total_count } = res?.response as unknown as ClerkPaginatedResponse<BillingPlanJSON>;

      return {
        total_count,
        data: requests.map(request => new BillingPlan(request)),
      };
    });
  };

  getCurrentPlan = async (): Promise<BillingPlanResource> => {
    const json = (
      await BaseResource._fetch({
        path: `${this.path()}/billing/current`,
        method: 'GET',
      })
    )?.response as unknown as BillingPlanJSON;

    return new BillingPlan(json);
  };

  createBillingPortalSession = async (params: CreateBillingPortalSessionParams): Promise<any> => {
    const { redirectUrl } = params || {};

    const json = (
      await BaseResource._fetch({
        path: `${this.path()}/billing/current`,
        method: 'POST',
        body: {
          redirect_url: redirectUrl,
        } as any,
      })
    )?.response as unknown as { redirect_url: string };

    return (window.location.href = json.redirect_url);
  };

  changeBillingPlan = async () => {};

  get verifiedExternalAccounts() {
    return this.externalAccounts.filter(externalAccount => externalAccount.verification?.status == 'verified');
  }

  get unverifiedExternalAccounts() {
    return this.externalAccounts.filter(externalAccount => externalAccount.verification?.status != 'verified');
  }

  get hasVerifiedEmailAddress() {
    return this.emailAddresses.filter(email => email.verification.status === 'verified').length > 0;
  }

  get hasVerifiedPhoneNumber() {
    return this.phoneNumbers.filter(phone => phone.verification.status === 'verified').length > 0;
  }

  protected fromJSON(data: UserJSON | null): this {
    if (!data) {
      return this;
    }

    this.id = data.id;
    this.externalId = data.external_id;
    this.firstName = data.first_name;
    this.lastName = data.last_name;
    if (this.firstName || this.lastName) {
      this.fullName = getFullName({ firstName: this.firstName, lastName: this.lastName });
    }

    this.imageUrl = data.image_url;
    this.hasImage = data.has_image;
    this.username = data.username;
    this.passwordEnabled = data.password_enabled;
    this.emailAddresses = (data.email_addresses || []).map(
      ea => new EmailAddress(ea, this.path() + '/email_addresses'),
    );

    this.primaryEmailAddressId = data.primary_email_address_id;
    this.primaryEmailAddress = this.emailAddresses.find(({ id }) => id === this.primaryEmailAddressId) || null;

    this.phoneNumbers = (data.phone_numbers || []).map(ph => new PhoneNumber(ph, this.path() + '/phone_numbers'));

    this.primaryPhoneNumberId = data.primary_phone_number_id;
    this.primaryPhoneNumber = this.phoneNumbers.find(({ id }) => id === this.primaryPhoneNumberId) || null;

    this.web3Wallets = (data.web3_wallets || []).map(ph => new Web3Wallet(ph, this.path() + '/web3_wallets'));

    this.primaryWeb3WalletId = data.primary_web3_wallet_id;
    this.primaryWeb3Wallet = this.web3Wallets.find(({ id }) => id === this.primaryWeb3WalletId) || null;

    this.externalAccounts = (data.external_accounts || []).map(
      ea => new ExternalAccount(ea, this.path() + '/external_accounts'),
    );

    this.__experimental_passkeys = (data.passkeys || []).map(passkey => new Passkey(passkey));
    this.passkeys = (data.passkeys || []).map(passkey => new Passkey(passkey));

    this.organizationMemberships = (data.organization_memberships || []).map(om => new OrganizationMembership(om));

    this.samlAccounts = (data.saml_accounts || []).map(sa => new SamlAccount(sa, this.path() + '/saml_accounts'));

    this.publicMetadata = data.public_metadata;
    this.unsafeMetadata = data.unsafe_metadata;

    this.totpEnabled = data.totp_enabled;
    this.backupCodeEnabled = data.backup_code_enabled;
    this.twoFactorEnabled = data.two_factor_enabled;

    this.createOrganizationEnabled = data.create_organization_enabled;
    this.deleteSelfEnabled = data.delete_self_enabled;

    if (data.last_sign_in_at) {
      this.lastSignInAt = unixEpochToDate(data.last_sign_in_at);
    }

    this.updatedAt = unixEpochToDate(data.updated_at);
    this.createdAt = unixEpochToDate(data.created_at);
    return this;
  }
}
