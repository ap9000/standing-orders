import Foundation
import Darwin

// The updater validates signatures, paths, hashes and service shutdown first.
// One filesystem operation leaves the installation at either old or new code,
// never missing between two renames. Unsupported volumes fail without fallback.
let arguments = CommandLine.arguments
guard arguments.count == 3 else { fputs("Two bundle paths are required.\n", stderr); exit(2) }
let left = URL(fileURLWithPath: arguments[1]).resolvingSymlinksInPath().path
let right = URL(fileURLWithPath: arguments[2]).resolvingSymlinksInPath().path
guard left != right, left.hasSuffix(".app"), right.hasSuffix(".app") else { fputs("Choose two different app bundles.\n", stderr); exit(2) }
var a = stat(), b = stat()
guard lstat(arguments[1], &a) == 0, lstat(arguments[2], &b) == 0,
      (a.st_mode & S_IFMT) == S_IFDIR, (b.st_mode & S_IFMT) == S_IFDIR,
      a.st_dev == b.st_dev else { fputs("Both bundles must be directories on the same volume.\n", stderr); exit(2) }
guard renamex_np(left, right, UInt32(RENAME_SWAP)) == 0 else { perror("The atomic app swap failed; neither app was replaced"); exit(1) }
for parent in Set([URL(fileURLWithPath: left).deletingLastPathComponent().path, URL(fileURLWithPath: right).deletingLastPathComponent().path]) {
    let fd = open(parent, O_RDONLY); if fd >= 0 { _ = fsync(fd); close(fd) }
}
