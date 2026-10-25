{
  description = "Uomi Android and Tauri Linux development environment";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  outputs = { self, nixpkgs }: let
    system = "x86_64-linux";
    pkgs = import nixpkgs { inherit system; };
    cliSrc = pkgs.lib.cleanSource ./apps/cli;
    uomi-cli = pkgs.writeShellApplication {
      name = "uomi";
      runtimeInputs = [ pkgs.bun ];
      text = ''
        exec bun ${cliSrc}/src/main.ts "$@"
      '';
    };
  in {
    devShells.${system}.default = pkgs.mkShell {
      packages = with pkgs; [ cargo rustc pkg-config gtk3 webkitgtk_4_1 libayatana-appindicator librsvg openssl dbus libsecret networkmanager bluez nodejs_24 bun ];
      LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath (with pkgs; [ gtk3 webkitgtk_4_1 libayatana-appindicator librsvg openssl dbus ]);
      GIO_MODULE_DIR = "${pkgs.glib-networking}/lib/gio/modules";
      GSETTINGS_SCHEMA_DIR = "${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}/glib-2.0/schemas";
    };
    packages.${system}.uomi-cli = uomi-cli;
    apps.${system}.uomi-cli = {
      type = "app";
      program = "${uomi-cli}/bin/uomi";
    };
  };
}
