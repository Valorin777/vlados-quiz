// Everything the panel writes besides host commands, behind one interface: Firebase for real, an
// in-memory copy for the DEV rehearsal mode (demo/). Screens never call Firestore directly.

import type { AdminContentDoc, MediaMetaDoc } from '@shared/fbtypes';
import type { User } from 'firebase/auth';
import { getDoc, setDoc } from 'firebase/firestore';
import type { Fb } from '../../../fb/app';
import { signOutUser } from '../../../fb/auth';
import { mediaUrl, uploadMedia, type UploadMediaInput } from '../../../fb/media';
import type { Host } from '../../../host';
import { stripUndefined } from '../../../host/pure';
import { seedContentDoc } from './seed';

/** The part of Host the panel uses (the rehearsal simulator implements the same). */
export type HostLike = Pick<Host, 'snapshot' | 'adminView' | 'subscribe' | 'now' | 'command'>;

export type AdminUser = Pick<User, 'uid' | 'email' | 'emailVerified'>;

export interface MediaBackend {
  upload(input: Omit<UploadMediaInput, 'id'>): Promise<{ id: string; meta: MediaMetaDoc }>;
  /** Object URL of the file (cached per device). */
  url(id: string): Promise<string>;
  /** null: no such file. */
  meta(id: string): Promise<MediaMetaDoc | null>;
}

export interface AdminBackend {
  /** true in the rehearsal mode (nothing reaches Firestore). */
  demo: boolean;
  media: MediaBackend;
  writeContent(doc: AdminContentDoc): Promise<void>;
  seed(withTemplates: boolean): Promise<'created' | 'exists'>;
  getAdmins(): Promise<string[]>;
  setAdmins(emails: string[]): Promise<void>;
  signOut(): Promise<void>;
}

export function firebaseBackend(fb: Fb): AdminBackend {
  return {
    demo: false,
    media: {
      upload: (input) => uploadMedia(fb.refs, input),
      url: (id) => mediaUrl(fb.refs, id),
      meta: async (id) => (await getDoc(fb.refs.mediaMeta(id))).data() ?? null,
    },
    writeContent: (doc) => setDoc(fb.refs.adminContent(), stripUndefined(doc)),
    seed: (withTemplates) => seedContentDoc(fb, withTemplates),
    getAdmins: async () => (await getDoc(fb.refs.configAdmins())).data()?.emails ?? [],
    setAdmins: (emails) => setDoc(fb.refs.configAdmins(), { emails }),
    signOut: () => signOutUser(fb.auth),
  };
}
