{ pkgs, ... }:
{
  # Go toolchain for the PiG-native extension (build/test via `devenv shell --`).
  languages.go.enable = true;
}
