/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GOOGLE_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface GoogleCredentialResponse {
  credential?: string;
}

interface GoogleAccountsIdApi {
  initialize(options: {
    client_id: string;
    callback: (response: GoogleCredentialResponse) => void;
    ux_mode?: "popup" | "redirect";
    login_uri?: string;
  }): void;
  renderButton(
    parent: HTMLElement,
    options: {
      type?: string;
      theme?: string;
      size?: string;
      text?: string;
      shape?: string;
      width?: number;
      logo_alignment?: string;
    }
  ): void;
  disableAutoSelect(): void;
}

interface Window {
  google?: {
    accounts: {
      id: GoogleAccountsIdApi;
    };
  };
}
