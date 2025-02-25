import { PCDCrypto } from "@pcd/passport-crypto";
import {
  agreeTerms,
  applyActions,
  CredentialManager,
  Feed,
  FeedSubscriptionManager,
  isSyncedEncryptedStorageV2,
  isSyncedEncryptedStorageV3,
  KnownTicketTypesAndKeys,
  LATEST_PRIVACY_NOTICE,
  NetworkFeedApi,
  requestCreateNewUser,
  requestLogToServer,
  requestUser,
  SyncedEncryptedStorage,
  User
} from "@pcd/passport-interface";
import { PCDCollection, PCDPermission } from "@pcd/pcd-collection";
import { SerializedPCD } from "@pcd/pcd-types";
import {
  SemaphoreIdentityPCD,
  SemaphoreIdentityPCDPackage,
  SemaphoreIdentityPCDTypeName
} from "@pcd/semaphore-identity-pcd";
import { sleep } from "@pcd/util";
import { Identity } from "@semaphore-protocol/identity";
import { createContext } from "react";
import { appConfig } from "./appConfig";
import { notifyPasswordChangeOnOtherTabs } from "./broadcastChannel";
import { addDefaultSubscriptions } from "./defaultSubscriptions";
import {
  loadEncryptionKey,
  loadPrivacyNoticeAgreed,
  loadSelf,
  saveEncryptionKey,
  saveIdentity,
  savePCDs,
  saveSelf,
  saveSubscriptions
} from "./localstorage";
import { getPackages } from "./pcdPackages";
import { hasPendingRequest } from "./sessionStorage";
import { AppError, AppState, GetState, StateEmitter } from "./state";
import { hasSetupPassword } from "./user";
import { downloadStorage, uploadStorage } from "./useSyncE2EEStorage";
import { assertUnreachable } from "./util";

export type Dispatcher = (action: Action) => void;

export type Action =
  | {
      type: "new-passport";
      email: string;
    }
  | {
      type: "create-user-skip-password";
      email: string;
      token: string;
    }
  | {
      type: "login";
      email: string;
      password: string;
      token: string;
    }
  | {
      type: "set-self";
      self: User;
    }
  | {
      type: "set-modal";
      modal: AppState["modal"];
    }
  | {
      type: "error";
      error: AppError;
    }
  | {
      type: "clear-error";
    }
  | {
      type: "reset-passport";
    }
  | { type: "participant-invalid" }
  | {
      type: "load-from-sync";
      storage: SyncedEncryptedStorage;
      encryptionKey: string;
    }
  | { type: "change-password"; newEncryptionKey: string; newSalt: string }
  | { type: "password-change-on-other-tab" }
  | { type: "add-pcds"; pcds: SerializedPCD[]; upsert?: boolean }
  | { type: "remove-pcd"; id: string }
  | { type: "sync" }
  | { type: "resolve-subscription-error"; subscriptionId: string }
  | {
      type: "add-subscription";
      providerUrl: string;
      providerName: string;
      feed: Feed;
    }
  | { type: "remove-subscription"; subscriptionId: string }
  | {
      type: "update-subscription-permissions";
      subscriptionId: string;
      permissions: PCDPermission[];
    }
  | {
      type: "set-known-ticket-types-and-keys";
      knownTicketTypesAndKeys: KnownTicketTypesAndKeys;
    }
  | {
      type: "handle-agreed-privacy-notice";
      version: number;
    }
  | {
      type: "prompt-to-agree-privacy-notice";
    }
  | {
      type: "sync-subscription";
      subscriptionId: string;
    };

export type StateContextState = {
  getState: GetState;
  stateEmitter: StateEmitter;
  dispatch: Dispatcher;
};
export const StateContext = createContext<StateContextState>({} as any);

export type ZuUpdate = (s: Partial<AppState>) => void;

export async function dispatch(
  action: Action,
  state: AppState,
  update: ZuUpdate
) {
  switch (action.type) {
    case "new-passport":
      return genPassport(state.identity, action.email, update);
    case "create-user-skip-password":
      return createNewUserSkipPassword(
        action.email,
        action.token,
        state,
        update
      );
    case "login":
      return createNewUserWithPassword(
        action.email,
        action.token,
        action.password,
        state,
        update
      );
    case "set-self":
      return setSelf(action.self, state, update);
    case "error":
      return update({ error: action.error });
    case "clear-error":
      return clearError(state, update);
    case "reset-passport":
      return resetPassport(state, update);
    case "load-from-sync":
      return loadFromSync(action.encryptionKey, action.storage, update);
    case "set-modal":
      return update({
        modal: action.modal
      });
    case "password-change-on-other-tab":
      return handlePasswordChangeOnOtherTab(update);
    case "change-password":
      return saveNewPasswordAndBroadcast(
        action.newEncryptionKey,
        action.newSalt,
        state,
        update
      );
    case "add-pcds":
      return addPCDs(state, update, action.pcds, action.upsert);
    case "remove-pcd":
      return removePCD(state, update, action.id);
    case "participant-invalid":
      return userInvalid(update);
    case "sync":
      return sync(state, update);
    case "resolve-subscription-error":
      return resolveSubscriptionError(state, update, action.subscriptionId);
    case "add-subscription":
      return addSubscription(
        state,
        update,
        action.providerUrl,
        action.providerName,
        action.feed
      );
    case "remove-subscription":
      return removeSubscription(state, update, action.subscriptionId);
    case "update-subscription-permissions":
      return updateSubscriptionPermissions(
        state,
        update,
        action.subscriptionId,
        action.permissions
      );
    case "set-known-ticket-types-and-keys":
      return setKnownTicketTypesAndKeys(
        state,
        update,
        action.knownTicketTypesAndKeys
      );
    case "handle-agreed-privacy-notice":
      return handleAgreedPrivacyNotice(state, update, action.version);
    case "prompt-to-agree-privacy-notice":
      return promptToAgreePrivacyNotice(state, update);
    case "sync-subscription":
      return syncSubscription(state, update, action.subscriptionId);
    default:
      // We can ensure that we never get here using the type system
      assertUnreachable(action);
  }
}

async function genPassport(
  identity: Identity,
  email: string,
  update: ZuUpdate
) {
  const identityPCD = await SemaphoreIdentityPCDPackage.prove({ identity });
  const pcds = new PCDCollection(await getPackages(), [identityPCD]);

  await savePCDs(pcds);

  window.location.hash = "#/new-passport?email=" + encodeURIComponent(email);

  update({ pcds });
}

async function createNewUserSkipPassword(
  email: string,
  token: string,
  state: AppState,
  update: ZuUpdate
) {
  update({
    modal: { modalType: "none" }
  });
  const crypto = await PCDCrypto.newInstance();
  const encryptionKey = await crypto.generateRandomKey();
  await saveEncryptionKey(encryptionKey);

  update({
    encryptionKey
  });

  const newUserResult = await requestCreateNewUser(
    appConfig.zupassServer,
    email,
    token,
    state.identity.commitment.toString(),
    undefined,
    encryptionKey
  );

  if (newUserResult.success) {
    return finishLogin(newUserResult.value, state, update);
  }

  update({
    error: {
      title: "Account creation failed",
      message: "Couldn't create an account. " + newUserResult.error,
      dismissToCurrentPage: true
    }
  });
}

async function createNewUserWithPassword(
  email: string,
  token: string,
  password: string,
  state: AppState,
  update: ZuUpdate
) {
  const crypto = await PCDCrypto.newInstance();
  const { salt: newSalt, key: encryptionKey } =
    await crypto.generateSaltAndEncryptionKey(password);

  await saveEncryptionKey(encryptionKey);

  update({
    encryptionKey
  });

  const newUserResult = await requestCreateNewUser(
    appConfig.zupassServer,
    email,
    token,
    state.identity.commitment.toString(),
    newSalt,
    undefined
  );

  if (newUserResult.success) {
    return finishLogin(newUserResult.value, state, update);
  }

  update({
    error: {
      title: "Login failed",
      message: "Couldn't log in. " + newUserResult.error,
      dismissToCurrentPage: true
    }
  });
}

/**
 * Runs the first time the user logs in with their email
 */
async function finishLogin(user: User, state: AppState, update: ZuUpdate) {
  // Verify that the identity is correct.
  const { identity } = state;

  console.log("Save self", identity, user);

  if (identity == null || identity.commitment.toString() !== user.commitment) {
    update({
      error: {
        title: "Invalid identity",
        message: "Something went wrong saving your Zupass. Contact support."
      }
    });
  }

  await addDefaultSubscriptions(state.subscriptions);

  // Save to local storage.
  await setSelf(user, state, update);

  // Save PCDs to E2EE storage.
  await uploadStorage();

  // Close any existing modal, if it exists
  update({ modal: { modalType: "none" } });

  if (hasPendingRequest()) {
    window.location.hash = "#/login-interstitial";
  } else {
    window.location.hash = "#/";
  }
}

// Runs periodically, whenever we poll new participant info and when we broadcast state updates.
async function setSelf(self: User, state: AppState, update: ZuUpdate) {
  let userMismatched = false;
  let hasChangedPassword = false;

  if (state.self && self.salt != state.self.salt) {
    // If the password has been changed on a different device, the salts will mismatch
    console.log("User salt mismatch");
    hasChangedPassword = true;
    requestLogToServer(
      appConfig.zupassServer,
      "another-device-changed-password",
      {
        oldSalt: state.self.salt,
        newSalt: self.salt,
        email: self.email
      }
    );
  } else if (
    BigInt(self.commitment).toString() !== state.identity.commitment.toString()
  ) {
    console.log("Identity commitment mismatch");
    userMismatched = true;
    requestLogToServer(appConfig.zupassServer, "invalid-user", {
      oldCommitment: state.identity.commitment.toString(),
      newCommitment: self.commitment.toString()
    });
  } else if (state.self && state.self.uuid !== self.uuid) {
    console.log("User UUID mismatch");
    userMismatched = true;
    requestLogToServer(appConfig.zupassServer, "invalid-user", {
      oldUUID: state.self.uuid,
      newUUID: self.uuid
    });
  }

  if (hasChangedPassword) {
    anotherDeviceChangedPassword(update);
    return;
  }

  if (userMismatched) {
    userInvalid(update);
    return;
  }

  saveSelf(self); // Save to local storage.
  update({ self }); // Update in-memory state.
}

function clearError(state: AppState, update: ZuUpdate) {
  if (!state.error?.dismissToCurrentPage) {
    window.location.hash = "#/";
  }
  update({ error: undefined });
}

async function resetPassport(state: AppState, update: ZuUpdate) {
  await requestLogToServer(appConfig.zupassServer, "logout", {
    uuid: state.self?.uuid,
    email: state.self?.email,
    commitment: state.self?.commitment
  });
  // Clear saved state.
  window.localStorage.clear();
  // Clear in-memory state
  update({
    self: undefined,
    modal: {
      modalType: "none"
    }
  });

  setTimeout(() => {
    window.location.reload();
  }, 1);
}

async function addPCDs(
  state: AppState,
  update: ZuUpdate,
  pcds: SerializedPCD[],
  upsert?: boolean
) {
  // Require user to set up a password before adding PCDs
  if (state.self && !hasSetupPassword(state.self)) {
    update({
      modal: {
        modalType: "require-add-password"
      }
    });
  }
  await state.pcds.deserializeAllAndAdd(pcds, { upsert });
  await savePCDs(state.pcds);
  update({ pcds: state.pcds });
}

async function removePCD(state: AppState, update: ZuUpdate, pcdId: string) {
  state.pcds.remove(pcdId);
  await savePCDs(state.pcds);
  update({ pcds: state.pcds });
}

async function loadFromSync(
  encryptionKey: string,
  storage: SyncedEncryptedStorage,
  update: ZuUpdate
) {
  let pcds: PCDCollection;
  let subscriptions: FeedSubscriptionManager;

  if (isSyncedEncryptedStorageV3(storage)) {
    pcds = await PCDCollection.deserialize(await getPackages(), storage.pcds);
    subscriptions = FeedSubscriptionManager.deserialize(
      new NetworkFeedApi(),
      storage.subscriptions
    );
  } else if (isSyncedEncryptedStorageV2(storage)) {
    pcds = await PCDCollection.deserialize(await getPackages(), storage.pcds);
  } else {
    pcds = await new PCDCollection(await getPackages());
    await pcds.deserializeAllAndAdd(storage.pcds);
  }

  // Poll the latest user stored from the database rather than using the `self` object from e2ee storage.
  const userResponse = await requestUser(
    appConfig.zupassServer,
    storage.self.uuid
  );
  if (!userResponse.success) {
    throw new Error(userResponse.error.errorMessage);
  }

  // assumes that we only have one semaphore identity in Zupass.
  const identityPCD = pcds.getPCDsByType(
    SemaphoreIdentityPCDTypeName
  )[0] as SemaphoreIdentityPCD;

  let modal: AppState["modal"] = { modalType: "none" };
  if (!identityPCD) {
    // TODO: handle error gracefully
    throw new Error("no identity found in encrypted storage");
  } else if (
    // If on Zupass legacy login, ask user to set passwrod
    self != null &&
    encryptionKey == null &&
    storage.self.salt == null
  ) {
    console.log("Asking existing user to set a password");
    modal = { modalType: "upgrade-account-modal" };
  }

  if (subscriptions) {
    await saveSubscriptions(subscriptions);
  }

  await savePCDs(pcds);
  saveEncryptionKey(encryptionKey);
  saveSelf(userResponse.value);
  saveIdentity(identityPCD.claim.identity);

  update({
    encryptionKey,
    pcds,
    identity: identityPCD.claim.identity,
    self: userResponse.value,
    modal
  });

  await sleep(1);

  console.log("Loaded from sync key, redirecting to home screen...");
  window.localStorage["savedSyncKey"] = "true";
  if (hasPendingRequest()) {
    window.location.hash = "#/login-interstitial";
  } else {
    window.location.hash = "#/";
  }
}

// Update `self` and `encryptionKey` in-memory fields from their saved values in localStorage
async function handlePasswordChangeOnOtherTab(update: ZuUpdate) {
  const self = loadSelf();
  const encryptionKey = loadEncryptionKey();
  return update({
    self,
    encryptionKey
  });
}

async function saveNewPasswordAndBroadcast(
  newEncryptionKey: string,
  newSalt: string,
  state: AppState,
  update: ZuUpdate
) {
  const newSelf = { ...state.self, salt: newSalt };
  saveSelf(newSelf);
  saveEncryptionKey(newEncryptionKey);
  notifyPasswordChangeOnOtherTabs();
  return update({
    encryptionKey: newEncryptionKey,
    self: newSelf
  });
}

function userInvalid(update: ZuUpdate) {
  update({
    userInvalid: true,
    modal: { modalType: "invalid-participant" }
  });
}

function anotherDeviceChangedPassword(update: ZuUpdate) {
  update({
    anotherDeviceChangedPassword: true,
    modal: { modalType: "another-device-changed-password" }
  });
}

async function makeUploadId(
  pcds: PCDCollection,
  subscriptions: FeedSubscriptionManager
): Promise<string> {
  return `${await pcds.getHash()}-${await subscriptions.getHash()}`;
}

/**
 * This sync function can be called any amount of times, and it will
 * function properly. It does the following:
 *
 * - if PCDs have not been downloaded yet, and are not in the
 *   process of being downloaded, kicks off the process of downloading
 *   them from e2ee.
 *
 * - if the PCDs have been downloaded, and the current set of PCDs
 *   in Zupass does not equal the downloaded set, and if
 *   Zupass is not currently uploading the current set of PCDs
 *   to e2ee, then uploads then to e2ee.
 */
async function sync(state: AppState, update: ZuUpdate) {
  if (loadEncryptionKey() == null) {
    console.log("[SYNC] no encryption key, can't sync");
    return;
  }

  // If we haven't downloaded from storage, do that first
  if (!state.downloadedPCDs && !state.downloadingPCDs) {
    console.log("[SYNC] sync action: download");
    update({
      downloadingPCDs: true
    });

    /**
     * Get both PCDs and subscriptions
     * Subscriptions might be null even if we got PCDs, if we were
     * downloading from a pre-v3 version of encrypted storage
     * {@link SyncedEncryptedStorageV3}
     * */
    const downloaded = await downloadStorage();

    if (downloaded != null && downloaded.pcds != null) {
      const { pcds, subscriptions } = downloaded;

      if (subscriptions) {
        addDefaultSubscriptions(subscriptions);
      }

      update({
        downloadedPCDs: true,
        downloadingPCDs: false,
        pcds: pcds,
        // If we got subscriptions, add them and generate an upload ID.
        // The upload ID is a combination of hashes of the states of the PCDs
        // and subscriptions.
        // If later subscription-polling doesn't change the PCD set, we can
        // avoid having to do an upload.
        // If we didn't get subscriptions, it's because we downloaded from a
        // pre-v3 version of encrypted storage and therefore we definitely
        // want to do an upload.
        ...(subscriptions !== null
          ? {
              uploadedUploadId: await makeUploadId(pcds, subscriptions),
              subscriptions
            }
          : {})
      });
    } else {
      console.log(`[SYNC] skipping download`);
      update({
        downloadedPCDs: true,
        downloadingPCDs: false
      });
    }

    return;
  }

  if (state.downloadingPCDs || !state.downloadedPCDs) {
    return;
  }

  if (!state.loadedIssuedPCDs && !state.loadingIssuedPCDs) {
    update({
      loadingIssuedPCDs: true
    });

    try {
      console.log("[SYNC] loading issued pcds");
      console.log(
        "[SYNC] active subscriptions",
        state.subscriptions.getActiveSubscriptions()
      );
      const credentialManager = new CredentialManager(
        state.identity,
        state.pcds,
        state.credentialCache
      );
      console.log("[SYNC] initalized credentialManager", credentialManager);
      const actions =
        await state.subscriptions.pollSubscriptions(credentialManager);
      console.log("[SYNC] fetched actions", actions);

      await applyActions(state.pcds, actions);
      console.log("[SYNC] applied pcd actions");
      await savePCDs(state.pcds);
      console.log("[SYNC] loaded and saved issued pcds");
    } catch (e) {
      console.log(`[SYNC] failed to load issued PCDs, skipping this step`, e);
    }

    update({
      loadingIssuedPCDs: false,
      loadedIssuedPCDs: true,
      pcds: state.pcds
    });
    return;
  }

  if (!state.loadedIssuedPCDs && state.loadingIssuedPCDs) {
    return;
  }

  // Generate an upload ID from the state of PCDs and subscriptions
  const uploadId = await makeUploadId(state.pcds, state.subscriptions);

  // If it matches what we downloaded or uploaded already, there's nothing
  // to do
  if (
    state.uploadedUploadId === uploadId ||
    state.uploadingUploadId === uploadId
  ) {
    console.log("[SYNC] sync action: no-op");
    return;
  }

  console.log("[SYNC] sync action: upload");
  update({
    uploadingUploadId: uploadId
  });
  await uploadStorage();
  update({
    uploadingUploadId: undefined,
    uploadedUploadId: uploadId
  });
}

async function syncSubscription(
  state: AppState,
  update: ZuUpdate,
  subscriptionId: string
) {
  try {
    console.log("[SYNC] loading pcds from subscription", subscriptionId);
    const subscription = state.subscriptions.getSubscription(subscriptionId);
    const credentialManager = new CredentialManager(
      state.identity,
      state.pcds,
      state.credentialCache
    );
    const actions = await state.subscriptions.pollSingleSubscription(
      subscription,
      credentialManager
    );
    console.log("[SYNC] fetched actions", actions);

    await applyActions(state.pcds, actions);
    console.log("[SYNC] applied pcd actions");
    await savePCDs(state.pcds);
    console.log("[SYNC] loaded and saved issued pcds");

    update({
      pcds: state.pcds
    });
  } catch (e) {
    console.log(`[SYNC] failed to load issued PCDs, skipping this step`, e);
  }
}

async function resolveSubscriptionError(
  _state: AppState,
  update: ZuUpdate,
  subscriptionId: string
) {
  update({
    resolvingSubscriptionId: subscriptionId,
    modal: { modalType: "resolve-subscription-error" }
  });
}

async function addSubscription(
  state: AppState,
  update: ZuUpdate,
  providerUrl: string,
  providerName: string,
  feed: Feed
) {
  if (!state.subscriptions.getProvider(providerUrl)) {
    state.subscriptions.addProvider(providerUrl, providerName);
  }
  await state.subscriptions.subscribe(providerUrl, feed, true);
  await saveSubscriptions(state.subscriptions);
  update({
    subscriptions: state.subscriptions,
    loadedIssuedPCDs: false,
    loadingIssuedPCDs: false
  });
}

async function removeSubscription(
  state: AppState,
  update: ZuUpdate,
  subscriptionId: string
) {
  state.subscriptions.unsubscribe(subscriptionId);
  await saveSubscriptions(state.subscriptions);
  update({
    subscriptions: state.subscriptions
  });
}

async function updateSubscriptionPermissions(
  state: AppState,
  update: ZuUpdate,
  subscriptionId: string,
  permisisons: PCDPermission[]
) {
  state.subscriptions.updateFeedPermissionsForSubscription(
    subscriptionId,
    permisisons
  );
  state.subscriptions.resetError(subscriptionId);
  await saveSubscriptions(state.subscriptions);
  update({
    subscriptions: state.subscriptions,
    loadedIssuedPCDs: false,
    loadingIssuedPCDs: false
  });
}

async function setKnownTicketTypesAndKeys(
  _state: AppState,
  update: ZuUpdate,
  knownTicketTypesAndKeys: KnownTicketTypesAndKeys
) {
  const keyMap = {};
  knownTicketTypesAndKeys.publicKeys.forEach((k) => {
    if (!keyMap[k.publicKeyType]) {
      keyMap[k.publicKeyType] = {};
    }
    keyMap[k.publicKeyType][k.publicKeyName] = k;
  });

  update({
    knownTicketTypes: knownTicketTypesAndKeys.knownTicketTypes,
    knownPublicKeys: keyMap
  });
}

/**
 * After the user has agreed to the terms, save the updated user record, set
 * `loadedIssuedPCDs` and `loadingIssuedPCDs` to false in order to prompt a
 * feed refresh, and dismiss the "legal terms" modal.
 */
async function handleAgreedPrivacyNotice(
  state: AppState,
  update: ZuUpdate,
  version: number
) {
  await saveSelf({ ...state.self, terms_agreed: version });
  update({
    self: { ...state.self, terms_agreed: version },
    loadedIssuedPCDs: false,
    loadingIssuedPCDs: false,
    modal: { modalType: "none" }
  });
}

/**
 * If the `user` object doesn't indicate that the user has agreed to the
 * latest terms, check local storage in case they've agreed but we failed
 * to sync it. If so, sync to server. If not, prompt user with an
 * un-dismissable modal.
 */
async function promptToAgreePrivacyNotice(state: AppState, update: ZuUpdate) {
  const cachedTerms = loadPrivacyNoticeAgreed();
  if (cachedTerms === LATEST_PRIVACY_NOTICE) {
    // sync to server
    await agreeTerms(
      appConfig.zupassServer,
      LATEST_PRIVACY_NOTICE,
      state.identity
    );
  } else {
    update({
      modal: {
        modalType: "privacy-notice"
      }
    });
  }
}
