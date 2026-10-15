FROM debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241
RUN apt-get update && apt-get install -y --no-install-recommends \
    autoconf automake build-essential binutils ca-certificates git libtool \
    libunbound-dev pkg-config
COPY compile.sh /usr/local/bin/compile-hns-checkpoint
ENTRYPOINT ["nice", "-n", "19", "/bin/bash", "/usr/local/bin/compile-hns-checkpoint"]
