import { isClerkAPIResponseError } from '@clerk/shared/error';
import { joinURL } from '@clerk/shared/url';
import type {
  PrepareFirstFactorParams,
  PrepareSecondFactorParams,
  SignInFirstFactor,
  SignInResource,
  SignInSecondFactor,
  SignInStatus,
  SignInStrategy,
} from '@clerk/types';
import type { NonReducibleUnknown } from 'xstate';
import { and, assertEvent, assign, enqueueActions, log, not, or, raise, sendTo, setup } from 'xstate';

import {
  CHOOSE_SESSION_PATH_ROUTE,
  ERROR_CODES,
  MAGIC_LINK_VERIFY_PATH_ROUTE,
  RESENDABLE_COUNTDOWN_DEFAULT,
  ROUTING,
  SIGN_IN_DEFAULT_BASE_PATH,
  SIGN_UP_DEFAULT_BASE_PATH,
  SSO_CALLBACK_PATH_ROUTE,
} from '~/internals/constants';
import { ClerkElementsError, ClerkElementsRuntimeError } from '~/internals/errors';
import { FormMachine } from '~/internals/machines/form';
import { ThirdPartyMachine, ThirdPartyMachineId } from '~/internals/machines/third-party';
import type { BaseRouterLoadingStep } from '~/internals/machines/types';
import { assertActorEventDone, assertActorEventError } from '~/internals/machines/utils/assert';
import { shouldUseVirtualRouting } from '~/internals/machines/utils/next';

import {
  attemptPasskey,
  attemptWeb3,
  firstFactorAttempt,
  firstFactorDetermineStartingFactor,
  firstFactorPrepare,
  resetPasswordAttempt,
  secondFactorAttempt,
  secondFactorDetermineStartingFactor,
  secondFactorPrepare,
  startAttempt,
  webAuthnAutofillSupport,
} from './actors';
import {
  type SignInRouterContext,
  SignInRouterDelays,
  type SignInRouterEvents,
  type SignInRouterNextEvent,
  type SignInRouterSchema,
  type SignInRouterSessionSetActiveEvent,
} from './router.types';

export type TSignInRouterMachine = typeof SignInRouterMachine;

const isCurrentPath =
  (path: `/${string}`) =>
  ({ context }: { context: SignInRouterContext }, _params?: NonReducibleUnknown) => {
    return context.router?.match(path) ?? false;
  };

const needsStatus =
  (status: SignInStatus) =>
  ({ context, event }: { context: SignInRouterContext; event?: SignInRouterEvents }, _?: NonReducibleUnknown) =>
    (event as SignInRouterNextEvent)?.resource?.status === status || context.clerk?.client.signIn.status === status;

export const SignInRouterMachineId = 'SignInRouter';

export const SignInRouterMachine = setup({
  actors: {
    // Global Actors
    attemptPasskey,
    attemptWeb3,

    // Start Actors
    startAttempt,

    // First Factor Actors
    firstFactorAttempt,
    firstFactorDetermineStartingFactor,
    firstFactorPrepare,

    // Second Factor Actors
    secondFactorAttempt,
    secondFactorDetermineStartingFactor,
    secondFactorPrepare,

    // Reset Password Actors
    resetPasswordAttempt,

    // Shared Machines
    formMachine: FormMachine,
    thirdPartyMachine: ThirdPartyMachine,

    // Other Actors
    webAuthnAutofillSupport,
  },
  actions: {
    // Clears all form errors
    clearFormErrors: sendTo(({ context }) => context.formRef, { type: 'ERRORS.CLEAR' }),
    // Clears all registered strategies used within the validation step
    clearRegisteredStrategies: assign({ registeredStrategies: new Set() }),
    // Returns the machine to the Init state after a delay
    delayedReset: raise({ type: 'RESET' }, { delay: 3000 }), // Reset machine after 3s delay.
    // Continues to the next valid step in the sign-in flow
    goToNextStep: enqueueActions(({ enqueue, event }) => {
      assertActorEventDone<SignInResource>(event);
      enqueue.raise({ type: 'NEXT', resource: event.output });
    }),
    resetResource: assign({ resource: ({ context }) => context.clerk.client.signIn }),
    setResource: assign({
      resource: ({ event }) => {
        assertActorEventDone<SignInResource>(event);
        return event.output;
      },
    }),
    navigateInternal: ({ context }, { path, force = false }: { path: string; force?: boolean }) => {
      if (!context.router) {
        return;
      }
      if (!force && shouldUseVirtualRouting()) {
        return;
      }
      if (context.exampleMode) {
        return;
      }

      const resolvedPath = joinURL(context.router.basePath, path);
      if (resolvedPath === context.router.pathname()) {
        return;
      }

      context.router.shallowPush(resolvedPath);
    },
    navigateExternal: ({ context }, { path }: { path: string }) => context.router?.push(path),
    loadingBegin: enqueueActions(
      (
        { enqueue },
        params: { step: BaseRouterLoadingStep; strategy?: SignInStrategy; action?: 'passkey' | 'submit' },
      ) => {
        const { step, strategy, action } = params;
        enqueue.assign({
          loading: {
            action,
            isLoading: true,
            step,
            strategy,
          },
        });
      },
    ),
    loadingEnd: assign({
      loading: {
        action: undefined,
        isLoading: false,
        step: undefined,
        strategy: undefined,
      },
    }),
    resendableTick: assign(({ context }) => ({
      resendable: context.resendableAfter === 0,
      resendableAfter: context.resendableAfter > 0 ? context.resendableAfter - 1 : context.resendableAfter,
    })),
    resendableReset: assign({
      resendable: false,
      resendableAfter: RESENDABLE_COUNTDOWN_DEFAULT,
    }),
    setActive: ({ context, event }) => {
      if (context.exampleMode) {
        return;
      }
      const resource = (event as SignInRouterNextEvent)?.resource;
      const id = (event as SignInRouterSessionSetActiveEvent)?.id;
      const lastActiveSessionId = context.clerk.client.lastActiveSessionId;
      const createdSessionId = (resource || context.clerk.client.signIn).createdSessionId;

      const session = id || createdSessionId || lastActiveSessionId || null;
      const url = context.router?.searchParams().get('redirect_url') || context.clerk.buildAfterSignInUrl();

      const beforeEmit = async () => {
        return await context.clerk.navigate(url);
      };

      void context.clerk.setActive({ session, beforeEmit });
    },
    setConsoleError: ({ event }) => {
      if (process.env.NODE_ENV !== 'development') {
        return;
      }

      assertActorEventError(event);

      const error = isClerkAPIResponseError(event.error) ? event.error.errors[0].longMessage : event.error.message;

      console.error(`Unable to fulfill the prepare or attempt request for the sign-in verification.
      Error: ${error}
      Please open an issue if you continue to run into this issue.`);
    },
    setError: assign({
      error: (_, { error }: { error?: ClerkElementsError }) => {
        if (error) {
          return error;
        }
        return new ClerkElementsRuntimeError('Unknown error');
      },
    }),
    setFormErrors: sendTo(
      ({ context }) => context.formRef,
      ({ event }) => {
        assertActorEventError(event);
        return {
          type: 'ERRORS.SET',
          error: event.error,
        };
      },
    ),
    setFormOAuthErrors: ({ context }) => {
      const errorOrig = context.clerk.client.signIn.firstFactorVerification.error;

      if (!errorOrig) {
        return;
      }

      let error: ClerkElementsError;

      switch (errorOrig.code) {
        case ERROR_CODES.NOT_ALLOWED_TO_SIGN_UP:
        case ERROR_CODES.OAUTH_ACCESS_DENIED:
        case ERROR_CODES.NOT_ALLOWED_ACCESS:
        case ERROR_CODES.SAML_USER_ATTRIBUTE_MISSING:
        case ERROR_CODES.OAUTH_EMAIL_DOMAIN_RESERVED_BY_SAML:
        case ERROR_CODES.USER_LOCKED:
          error = new ClerkElementsError(errorOrig.code, errorOrig.longMessage || '');
          break;
        default:
          error = new ClerkElementsError(
            'unable_to_complete',
            'Unable to complete action at this time. If the problem persists please contact support.',
          );
      }

      context.formRef.send({
        type: 'ERRORS.SET',
        error,
      });
    },
    setInitialContext: assign(({ event }) => {
      assertEvent(event, 'INIT');
      return {
        clerk: event.clerk,
        exampleMode: event.exampleMode || false,
        formRef: event.formRef,
        loading: {
          isLoading: false,
        },
        registeredStrategies: new Set(),
        resource: event.clerk.client.signIn,
        router: event.router,
        signUpPath: event.signUpPath || SIGN_UP_DEFAULT_BASE_PATH,
      };
    }),
    setValidationStrategy: assign({
      verificationCurrentFactor: ({ event }) => {
        assertEvent(event, 'STRATEGY.UPDATE');
        return event.factor || null;
      },
    }),
    setWebAuthnAutofillSupport: assign({ webAuthnAutofillSupport: (_, params: boolean) => params }),
    transfer: ({ context }) => {
      const searchParams = new URLSearchParams({ __clerk_transfer: '1' });
      context.router?.push(`${context.signUpPath}?${searchParams}`);
    },
    validateRegisteredStrategies: ({ context }) => {
      const { clerk, verificationCurrentFactor, registeredStrategies } = context;

      // Only show these warnings in development!
      if (process.env.NODE_ENV !== 'development' || clerk.__unstable__environment?.isProduction()) {
        return;
      }

      const supportedFirstFactors = clerk.client.signIn.supportedFirstFactors;
      const supportedSecondFactors = clerk.client.signIn.supportedSecondFactors;
      const registeredStrategiesArr = Array.from(registeredStrategies);

      // Ensure all configured strategies are rendered
      if (supportedFirstFactors && !supportedFirstFactors.every(f => registeredStrategies.has(f.strategy))) {
        const supportedFactorsStr = supportedFirstFactors.map(f => f.strategy).join(', ');
        const registeredFactorsStr = registeredStrategiesArr.join(', ');

        console.warn(
          `Clerk: Your instance is configured to support these strategies: ${supportedFactorsStr}, but the rendered strategies are: ${registeredFactorsStr}. Make sure to render a <Strategy> component for each supported strategy. More information: https://clerk.com/docs/elements/reference/sign-in#strategy`,
        );
      }

      // Ensure all rendered second factor strategies are supported
      if (supportedSecondFactors && !supportedSecondFactors.every(f => registeredStrategies.has(f.strategy))) {
        const supportedFactorsStr = supportedSecondFactors.map(f => f.strategy).join(', ');
        const registeredFactorsStr = registeredStrategiesArr.join(', ');

        console.warn(
          `Clerk: Your instance is configured to support these 2FA strategies: ${supportedFactorsStr}, but the rendered strategies are: ${registeredFactorsStr}. Make sure to render a <Strategy> component for each supported strategy. More information: https://clerk.com/docs/elements/reference/sign-in#strategy`,
        );
      }

      // Ensure all rendered first factor strategies are supported
      const strategiesUsedButNotActivated = registeredStrategiesArr.filter(
        strategy => !supportedFirstFactors?.some(supported => supported.strategy === strategy),
      );

      if (strategiesUsedButNotActivated.length > 0) {
        console.warn(
          `Clerk: These rendered strategies are not configured for your instance: ${strategiesUsedButNotActivated.join(', ')}. If this is unexpected, make sure to enable them in your Clerk dashboard: https://dashboard.clerk.com/last-active?path=/user-authentication/email-phone-username`,
        );
      }

      if (verificationCurrentFactor?.strategy && !registeredStrategies.has(verificationCurrentFactor?.strategy)) {
        throw new ClerkElementsRuntimeError(
          `Your sign-in attempt is missing a ${verificationCurrentFactor?.strategy} strategy. Make sure <Strategy name="${verificationCurrentFactor?.strategy}"> is rendered in your flow. More information: https://clerk.com/docs/elements/reference/sign-in#strategy`,
        );
      }

      if (!verificationCurrentFactor?.strategy) {
        throw new ClerkElementsRuntimeError(
          'Unable to determine an authentication strategy to verify. This means your instance is misconfigured. Visit the Clerk Dashboard and verify that your instance has authentication strategies enabled: https://dashboard.clerk.com/last-active?path=/user-authentication/email-phone-username',
        );
      }
    },
  },
  delays: SignInRouterDelays,
  guards: {
    hasAuthenticatedViaClerkJS: ({ context }) =>
      Boolean(context.clerk.client.signIn.status === null && context.clerk.client.lastActiveSessionId),
    hasOAuthError: ({ context }) => Boolean(context.clerk?.client?.signIn?.firstFactorVerification?.error),
    hasResource: ({ context }) => Boolean(context.clerk?.client?.signIn?.status),

    isLoggedInAndSingleSession: and(['isLoggedIn', 'isSingleSessionMode', 'isntExampleMode']),
    isActivePathRoot: isCurrentPath('/'),
    isComplete: ({ context, event }) => {
      const resource = (event as SignInRouterNextEvent)?.resource;
      const signIn = context.resource || context.clerk.client.signIn;

      return (
        (resource?.status === 'complete' && Boolean(resource?.createdSessionId)) ||
        (signIn.status === 'complete' && Boolean(signIn.createdSessionId))
      );
    },
    isntComplete: not('isComplete'),
    isLoggedIn: ({ context }) => Boolean(context.clerk?.user),
    isSingleSessionMode: ({ context }) => Boolean(context.clerk?.__unstable__environment?.authConfig.singleSessionMode),
    isExampleMode: ({ context }) => Boolean(context.exampleMode),
    isntExampleMode: ({ context }) => !context.exampleMode,
    isResendable: ({ context }) => context.resendable || context.resendableAfter === 0,
    isNeverResendable: ({ context }) => {
      if (!context.verificationCurrentFactor?.strategy) {
        return false;
      }

      return ['passkey', 'password'].includes(context.verificationCurrentFactor.strategy);
    },

    needsStart: or([not('hasResource'), 'statusNeedsIdentifier', isCurrentPath('/')]),
    needsFirstFactor: and(['statusNeedsFirstFactor', isCurrentPath('/continue')]),
    needsSecondFactor: and(['statusNeedsSecondFactor', isCurrentPath('/continue')]),
    needsCallback: isCurrentPath(SSO_CALLBACK_PATH_ROUTE),
    needsChooseSession: isCurrentPath(CHOOSE_SESSION_PATH_ROUTE),
    needsNewPassword: and(['statusNeedsNewPassword', isCurrentPath('/new-password')]),

    statusNeedsIdentifier: needsStatus('needs_identifier'),
    statusNeedsFirstFactor: needsStatus('needs_first_factor'),
    statusNeedsSecondFactor: needsStatus('needs_second_factor'),
    statusNeedsNewPassword: needsStatus('needs_new_password'),
  },
  types: {} as SignInRouterSchema,
}).createMachine({
  id: SignInRouterMachineId,
  // @ts-expect-error - Set in INIT event
  context: {},
  initial: 'Idle',
  on: {
    'AUTHENTICATE.OAUTH': {
      actions: sendTo(ThirdPartyMachineId, ({ context, event }) => ({
        type: 'REDIRECT',
        params: {
          strategy: event.strategy,
          redirectUrl: `${
            context.router?.mode === ROUTING.virtual
              ? context.clerk.__unstable__environment?.displayConfig.signInUrl
              : context.router?.basePath
          }${SSO_CALLBACK_PATH_ROUTE}`,
          redirectUrlComplete:
            context.router?.searchParams().get('redirect_url') || context.clerk.buildAfterSignInUrl(),
        },
      })),
    },
    'AUTHENTICATE.SAML': {
      actions: sendTo(ThirdPartyMachineId, ({ context }) => ({
        type: 'REDIRECT',
        params: {
          strategy: 'saml',
          identifier: context.formRef.getSnapshot().context.fields.get('identifier')?.value,
          redirectUrl: `${
            context.router?.mode === ROUTING.virtual
              ? context.clerk.__unstable__environment?.displayConfig.signInUrl
              : context.router?.basePath
          }${SSO_CALLBACK_PATH_ROUTE}`,
          redirectUrlComplete:
            context.router?.searchParams().get('redirect_url') || context.clerk.buildAfterSignInUrl(),
        },
      })),
    },
    'NAVIGATE.PREVIOUS': '.Hist',
    'NAVIGATE.START': '.Start',
    LOADING: {
      // TODO: Remove when no longer needed
      actions: assign(({ event }) => ({
        loading: {
          isLoading: event.isLoading,
          step: event.step,
          strategy: event.strategy,
          action: event.action,
        },
      })),
    },
    RESET: {
      actions: 'resetResource',
      target: '.Idle',
    },
  },
  states: {
    Idle: {
      invoke: {
        id: 'webAuthnAutofill',
        src: 'webAuthnAutofillSupport',
        onDone: {
          actions: {
            type: 'setWebAuthnAutofillSupport',
            params: ({ event }) => event.output,
          },
        },
      },
      on: {
        INIT: {
          actions: 'setInitialContext',
          target: 'Init',
        },
      },
    },
    Init: {
      entry: enqueueActions(({ context, enqueue, self }) => {
        if (!self.getSnapshot().children[ThirdPartyMachineId]) {
          enqueue.spawnChild('thirdPartyMachine', {
            id: ThirdPartyMachineId,
            systemId: ThirdPartyMachineId,
            input: {
              basePath: context.router?.basePath ?? SIGN_IN_DEFAULT_BASE_PATH,
              flow: 'signIn',
              formRef: context.formRef,
              parent: self,
            },
          });
        }
      }),
      always: [
        {
          guard: 'needsCallback',
          target: 'Callback',
        },
        {
          guard: 'needsChooseSession',
          target: 'ChooseSession',
        },
        {
          guard: 'isComplete',
          actions: ['setActive', 'delayedReset'],
        },
        {
          guard: 'isLoggedInAndSingleSession',
          actions: [
            log('Already logged in'),
            {
              type: 'navigateExternal',
              params: ({ context }) => ({
                path: context.router?.searchParams().get('redirect_url') || context.clerk.buildAfterSignInUrl(),
              }),
            },
          ],
        },
        {
          guard: 'needsStart',
          actions: { type: 'navigateInternal', params: { force: true, path: '/' } },
          target: 'Start',
        },
        {
          guard: 'needsFirstFactor',
          actions: { type: 'navigateInternal', params: { force: true, path: '/continue' } },
          target: 'FirstFactor',
        },
        {
          guard: 'needsSecondFactor',
          actions: { type: 'navigateInternal', params: { force: true, path: '/continue' } },
          target: 'SecondFactor',
        },
        {
          guard: 'needsNewPassword',
          actions: { type: 'navigateInternal', params: { force: true, path: '/reset-password' } },
          target: 'ResetPassword',
        },
        {
          actions: { type: 'navigateInternal', params: { force: true, path: '/' } },
          target: 'Start',
        },
      ],
    },
    Start: {
      tags: ['step:start'],
      exit: 'clearFormErrors',
      on: {
        NEXT: [
          {
            guard: 'isComplete',
            actions: ['setActive', 'delayedReset'],
          },
          {
            guard: 'statusNeedsFirstFactor',
            actions: { type: 'navigateInternal', params: { path: '/continue' } },
            target: 'FirstFactor',
          },
          {
            guard: 'statusNeedsSecondFactor',
            actions: { type: 'navigateInternal', params: { path: '/continue' } },
            target: 'SecondFactor',
          },
          {
            guard: 'statusNeedsNewPassword',
            actions: { type: 'navigateInternal', params: { path: '/reset-password' } },
            target: 'ResetPassword',
          },
        ],
      },
      initial: 'Pending',
      states: {
        Pending: {
          tags: ['state:pending'],
          description: 'Waiting for user input',
          on: {
            SUBMIT: {
              guard: 'isntExampleMode',
              target: 'Attempting',
              reenter: true,
            },
            'AUTHENTICATE.PASSKEY': {
              guard: 'isntExampleMode',
              target: 'AttemptingPasskey',
              reenter: true,
            },
            'AUTHENTICATE.PASSKEY.AUTOFILL': {
              guard: 'isntExampleMode',
              target: 'AttemptingPasskeyAutoFill',
              reenter: false,
            },
            'AUTHENTICATE.WEB3': {
              guard: 'isntExampleMode',
              target: 'AttemptingWeb3',
              reenter: true,
            },
          },
        },
        Attempting: {
          tags: ['state:attempting', 'state:loading'],
          entry: {
            type: 'loadingBegin',
            params: {
              step: 'start',
            },
          },
          exit: 'loadingEnd',
          invoke: {
            id: 'startAttempt',
            src: 'startAttempt',
            input: ({ context }) => ({
              clerk: context.clerk,
              fields: context.formRef.getSnapshot().context.fields,
            }),
            onDone: {
              actions: ['setResource', 'goToNextStep'],
            },
            onError: {
              actions: 'setFormErrors',
              target: 'Pending',
            },
          },
        },
        AttemptingPasskey: {
          tags: ['state:attempting', 'state:loading'],
          entry: {
            type: 'loadingBegin',
            params: {
              action: 'passkey',
              step: 'start',
            },
          },
          exit: 'loadingEnd',
          invoke: {
            id: 'attemptPasskey',
            src: 'attemptPasskey',
            input: ({ context }) => ({
              clerk: context.clerk,
              flow: 'discoverable',
            }),
            onDone: {
              actions: ['setResource', 'goToNextStep'],
            },
            onError: {
              actions: 'setFormErrors',
              target: 'Pending',
            },
          },
        },
        AttemptingPasskeyAutoFill: {
          invoke: {
            id: 'attemptPasskeyAutofill',
            src: 'attemptPasskey',
            input: ({ context }) => ({
              clerk: context.clerk,
              flow: 'autofill',
            }),
            onDone: {
              actions: ['setResource', 'goToNextStep'],
            },
            onError: {
              actions: 'setFormErrors',
              target: 'Pending',
            },
          },
        },
        AttemptingWeb3: {
          tags: ['state:attempting', 'state:loading'],
          entry: {
            type: 'loadingBegin',
            params: {
              step: 'start',
            },
          },
          exit: 'loadingEnd',
          invoke: {
            id: 'attemptWeb3',
            src: 'attemptWeb3',
            input: ({ context, event }) => {
              assertEvent(event, 'AUTHENTICATE.WEB3');
              return {
                clerk: context.clerk,
                strategy: event.strategy,
              };
            },
            onDone: {
              actions: ['setResource', 'goToNextStep'],
            },
            onError: {
              actions: 'setFormErrors',
              target: 'Pending',
            },
          },
        },
      },
    },
    FirstFactor: {
      tags: ['step:first-factor', 'step:verifications'],
      // exit: 'clearRegisteredStrategies', // TODO
      on: {
        'NAVIGATE.PREVIOUS': '.Hist',
        NEXT: [
          {
            guard: 'isComplete',
            actions: ['setActive', 'delayedReset'],
          },
          {
            guard: 'statusNeedsSecondFactor',
            actions: { type: 'navigateInternal', params: { path: '/continue' } },
            target: 'SecondFactor',
          },
          {
            guard: 'statusNeedsNewPassword',
            actions: { type: 'navigateInternal', params: { path: '/reset-password' } },
            target: 'ResetPassword',
          },
        ],
        'STRATEGY.REGISTER': {
          actions: assign({
            registeredStrategies: ({ context, event }) => context.registeredStrategies.add(event.factor),
          }),
        },
        'STRATEGY.UNREGISTER': {
          actions: assign({
            registeredStrategies: ({ context, event }) => {
              context.registeredStrategies.delete(event.factor);
              return context.registeredStrategies;
            },
          }),
        },
      },
      initial: 'Init',
      states: {
        Init: {
          tags: ['state:preparing', 'state:loading'],
          invoke: {
            id: 'firstFactorDetermineStartingFactor',
            src: 'firstFactorDetermineStartingFactor',
            input: ({ context }) => ({
              clerk: context.clerk,
            }),
            onDone: {
              target: 'Preparing',
              actions: assign({
                verificationCurrentFactor: ({ event }) => event.output,
              }),
            },
            onError: {
              target: 'Preparing',
              actions: [
                log('Clerk [Sign In Verification]: Error determining starting factor'),
                assign({
                  verificationCurrentFactor: { strategy: 'password' },
                }),
              ],
            },
          },
        },
        Preparing: {
          tags: ['state:preparing', 'state:loading'],
          invoke: {
            id: 'firstFactorPrepare',
            src: 'firstFactorPrepare',
            input: ({ context }) => ({
              clerk: context.clerk,
              resendable: context.resendable,
              params: {
                ...context.verificationCurrentFactor,
                redirectUrl: `${window.location.origin}${context.router?.basePath}${MAGIC_LINK_VERIFY_PATH_ROUTE}`,
              } as PrepareFirstFactorParams,
            }),
            onDone: {
              actions: ['setResource', 'resendableReset'],
              target: 'Pending',
            },
            onError: {
              actions: ['setFormErrors', 'setConsoleError'],
              target: 'Pending',
            },
          },
        },
        Pending: {
          tags: ['state:pending'],
          description: 'Waiting for user input',
          on: {
            'AUTHENTICATE.PASSKEY': {
              target: 'AttemptingPasskey',
              reenter: true,
            },
            'NAVIGATE.CHOOSE_STRATEGY': 'ChooseStrategy',
            'NAVIGATE.FORGOT_PASSWORD': 'ForgotPassword',
            RETRY: 'Preparing',
            SUBMIT: {
              target: 'Attempting',
              reenter: true,
            },
          },
          initial: 'Init',
          states: {
            Init: {
              description: 'Marks appropriate factors as never resendable.',
              always: [
                {
                  guard: 'isNeverResendable',
                  target: 'NeverResendable',
                },
                {
                  target: 'NotResendable',
                },
              ],
            },
            Resendable: {
              description: 'Waiting for user to retry',
            },
            NeverResendable: {
              description: 'Handles never resendable',
              on: {
                RETRY: {
                  actions: log('Never retriable'),
                },
              },
            },
            NotResendable: {
              description: 'Handle countdowns',
              on: {
                RETRY: {
                  actions: log(({ context }) => `Not retriable; Try again in ${context.resendableAfter}s`),
                },
              },
              after: {
                resendableTimeout: [
                  {
                    description: 'Set as retriable if countdown is 0',
                    guard: 'isResendable',
                    actions: 'resendableTick',
                    target: 'Resendable',
                  },
                  {
                    description: 'Continue countdown if not retriable',
                    actions: 'resendableTick',
                    target: 'NotResendable',
                    reenter: true,
                  },
                ],
              },
            },
          },
          after: {
            3000: {
              actions: 'validateRegisteredStrategies',
            },
          },
        },
        ChooseStrategy: {
          tags: ['step:choose-strategy'],
          on: {
            'NAVIGATE.PREVIOUS': 'Pending',
            'STRATEGY.UPDATE': {
              actions: 'setValidationStrategy',
              target: 'Preparing',
            },
          },
        },
        ForgotPassword: {
          tags: ['step:forgot-password'],
          on: {
            'NAVIGATE.PREVIOUS': 'Pending',
            'STRATEGY.UPDATE': {
              actions: 'setValidationStrategy',
              target: 'Preparing',
            },
          },
        },
        Attempting: {
          tags: ['state:attempting', 'state:loading'],
          entry: {
            type: 'loadingBegin',
            params: {
              step: 'verifications',
            },
          },
          exit: 'loadingEnd',
          invoke: {
            id: 'firstFactorAttempt',
            src: 'firstFactorAttempt',
            input: ({ context }) => ({
              clerk: context.clerk,
              currentFactor: context.verificationCurrentFactor as SignInFirstFactor | null,
              fields: context.formRef.getSnapshot().context.fields,
            }),
            onDone: {
              actions: ['setResource', 'goToNextStep'],
            },
            onError: {
              actions: 'setFormErrors',
              target: 'Pending',
            },
          },
        },
        AttemptingPasskey: {
          tags: ['state:attempting', 'state:loading'],
          entry: {
            type: 'loadingBegin',
            params: {
              step: 'verifications',
            },
          },
          exit: 'loadingEnd',
          invoke: {
            id: 'attemptPasskey',
            src: 'attemptPasskey',
            input: ({ context }) => ({
              clerk: context.clerk,
              flow: 'discoverable',
            }),
            onDone: {
              actions: ['setResource', 'goToNextStep'],
            },
            onError: {
              actions: 'setFormErrors',
              target: 'Pending',
            },
          },
        },
        Hist: {
          type: 'history',
        },
      },
    },
    SecondFactor: {
      tags: ['step:second-factor', 'step:verifications'],
      // exit: 'clearRegisteredStrategies', // TODO
      on: {
        'NAVIGATE.PREVIOUS': '.Hist',
        NEXT: [
          {
            guard: 'isComplete',
            actions: ['setActive', 'delayedReset'],
          },
          {
            guard: 'statusNeedsNewPassword',
            actions: { type: 'navigateInternal', params: { path: '/reset-password' } },
            target: 'ResetPassword',
          },
        ],
        'STRATEGY.REGISTER': {
          actions: assign({
            registeredStrategies: ({ context, event }) => context.registeredStrategies.add(event.factor),
          }),
        },
        'STRATEGY.UNREGISTER': {
          actions: assign({
            registeredStrategies: ({ context, event }) => {
              context.registeredStrategies.delete(event.factor);
              return context.registeredStrategies;
            },
          }),
        },
      },
      initial: 'Init',
      states: {
        Init: {
          tags: ['state:preparing', 'state:loading'],
          invoke: {
            id: 'secondFactorDetermineStartingFactor',
            src: 'secondFactorDetermineStartingFactor',
            input: ({ context }) => ({
              clerk: context.clerk,
            }),
            onDone: {
              target: 'Preparing',
              actions: assign({
                verificationCurrentFactor: ({ event }) => event.output,
              }),
            },
            onError: {
              target: 'Preparing',
              actions: [
                log('Clerk [Sign In Verification]: Error determining starting factor'),
                assign({
                  verificationCurrentFactor: { strategy: 'password' },
                }),
              ],
            },
          },
        },
        Preparing: {
          tags: ['state:preparing', 'state:loading'],
          invoke: {
            id: 'secondFactorPrepare',
            src: 'secondFactorPrepare',
            input: ({ context }) => ({
              clerk: context.clerk,
              resendable: context.resendable,
              params: context.verificationCurrentFactor as PrepareSecondFactorParams,
            }),
            onDone: {
              actions: ['setResource', 'resendableReset'],
              target: 'Pending',
            },
            onError: {
              actions: ['setFormErrors', 'setConsoleError'],
              target: 'Pending',
            },
          },
        },
        Pending: {
          tags: ['state:pending'],
          description: 'Waiting for user input',
          on: {
            'NAVIGATE.CHOOSE_STRATEGY': 'ChooseStrategy',
            RETRY: 'Preparing',
            SUBMIT: {
              target: 'Attempting',
              reenter: true,
            },
          },
          initial: 'Init',
          states: {
            Init: {
              description: 'Marks appropriate factors as never resendable.',
              always: [
                {
                  guard: 'isNeverResendable',
                  target: 'NeverResendable',
                },
                {
                  target: 'NotResendable',
                },
              ],
            },
            Resendable: {
              description: 'Waiting for user to retry',
            },
            NeverResendable: {
              description: 'Handles never resendable',
              on: {
                RETRY: {
                  actions: log('Never retriable'),
                },
              },
            },
            NotResendable: {
              description: 'Handle countdowns',
              on: {
                RETRY: {
                  actions: log(({ context }) => `Not retriable; Try again in ${context.resendableAfter}s`),
                },
              },
              after: {
                resendableTimeout: [
                  {
                    description: 'Set as retriable if countdown is 0',
                    guard: 'isResendable',
                    actions: 'resendableTick',
                    target: 'Resendable',
                  },
                  {
                    description: 'Continue countdown if not retriable',
                    actions: 'resendableTick',
                    target: 'NotResendable',
                    reenter: true,
                  },
                ],
              },
            },
          },
          after: {
            3000: {
              actions: 'validateRegisteredStrategies',
            },
          },
        },
        ChooseStrategy: {
          tags: ['step:choose-strategy'],
          on: {
            'NAVIGATE.PREVIOUS': 'Pending',
            'STRATEGY.UPDATE': {
              actions: 'setValidationStrategy',
              target: 'Preparing',
            },
          },
        },
        Attempting: {
          tags: ['state:attempting', 'state:loading'],
          entry: {
            type: 'loadingBegin',
            params: {
              step: 'verifications',
            },
          },
          exit: 'loadingEnd',
          invoke: {
            id: 'secondFactorAttempt',
            src: 'secondFactorAttempt',
            input: ({ context }) => ({
              clerk: context.clerk,
              currentFactor: context.verificationCurrentFactor as SignInSecondFactor | null,
              fields: context.formRef.getSnapshot().context.fields,
            }),
            onDone: {
              actions: ['setResource', 'goToNextStep'],
            },
            onError: {
              actions: 'setFormErrors',
              target: 'Pending',
            },
          },
        },
        Hist: {
          type: 'history',
        },
      },
    },
    ResetPassword: {
      tags: ['step:reset-password'],
      exit: 'clearFormErrors',
      on: {
        NEXT: [
          {
            guard: 'isComplete',
            actions: ['setActive', 'delayedReset'],
          },
          {
            guard: 'statusNeedsFirstFactor',
            actions: { type: 'navigateInternal', params: { path: '/continue' } },
            target: 'FirstFactor',
          },
          {
            guard: 'statusNeedsSecondFactor',
            actions: { type: 'navigateInternal', params: { path: '/continue' } },
            target: 'SecondFactor',
          },
        ],
      },
      initial: 'Pending',
      states: {
        Pending: {
          tags: ['state:pending'],
          description: 'Waiting for user input',
          on: {
            SUBMIT: {
              target: 'Attempting',
              reenter: true,
            },
          },
        },
        Attempting: {
          tags: ['state:attempting', 'state:loading'],
          entry: {
            type: 'loadingBegin',
            params: {
              step: 'reset-password',
            },
          },
          exit: 'loadingEnd',
          invoke: {
            id: 'resetPasswordAttempt',
            src: 'resetPasswordAttempt',
            input: ({ context }) => ({
              clerk: context.clerk,
              fields: context.formRef.getSnapshot().context.fields,
            }),
            onDone: {
              actions: ['setResource', 'goToNextStep'],
            },
            onError: {
              actions: 'setFormErrors',
              target: 'Pending',
            },
          },
        },
      },
    },
    Callback: {
      tags: ['step:callback'],
      entry: sendTo(ThirdPartyMachineId, { type: 'CALLBACK' }),
      on: {
        NEXT: [
          {
            guard: 'hasOAuthError',
            actions: ['setFormOAuthErrors', { type: 'navigateInternal', params: { force: true, path: '/' } }],
            target: 'Start',
          },
          {
            guard: or(['isLoggedIn', 'isComplete', 'hasAuthenticatedViaClerkJS']),
            actions: ['setActive', 'delayedReset'],
          },
          {
            guard: 'statusNeedsIdentifier',
            actions: 'transfer',
          },
          {
            guard: 'statusNeedsFirstFactor',
            actions: { type: 'navigateInternal', params: { path: '/continue' } },
            target: 'FirstFactor',
          },
          {
            guard: 'statusNeedsSecondFactor',
            actions: { type: 'navigateInternal', params: { path: '/continue' } },
            target: 'SecondFactor',
          },
          {
            guard: 'statusNeedsNewPassword',
            actions: { type: 'navigateInternal', params: { path: '/reset-password' } },
            target: 'ResetPassword',
          },
        ],
      },
    },
    ChooseSession: {
      tags: ['step:choose-session'],
      on: {
        'SESSION.SET_ACTIVE': {
          actions: [
            {
              type: 'setActive',
              params: ({ event }) => ({ id: event.id }),
            },
            'delayedReset',
          ],
        },
      },
    },
    Hist: {
      type: 'history',
      exit: 'clearFormErrors',
    },
  },
});
