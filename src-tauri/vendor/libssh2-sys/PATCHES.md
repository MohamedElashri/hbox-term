# libssh2-sys local patch

Source: crates.io libssh2-sys 0.3.2, previously pinned by the application.
Original crate SHA-256: c04141a07bb0c0bc461cb657808764de571702a59bc5c726c400ac9a7625e3ab.
The Rust binding/build files and the bundled libssh2 source/include files,
pkg-config template, and license notices are retained. Unused upstream docs,
examples, and build systems are omitted.

Changes:
- libssh2/src/agent.c: set agent->fd to LIBSSH2_INVALID_SOCKET immediately after
  closing it on Unix connect failure. Otherwise Agent::drop can close a descriptor
  that another thread has reused, corrupting unrelated sockets or files.
- build.rs: remove git submodule initialization; all required sources are checked in.

Regression: agent_transport::tests::failed_agent_connect_does_not_close_reused_descriptor.
Remove this patch when an upstream release includes the fix and the regression
passes against it. The separate EOF receive-loop workaround remains in the app.
