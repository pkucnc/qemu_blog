---
layout: default
title: 00 Introduction
---

# CLab QEMU Internals

This lecture series is adopted from the [QEMU Internals](https://airbus-seclab.github.io/qemu_blog/) blog posts published by Airbus Security Lab. Compared to the original posts, we changed the target architecture to `riscv64`, rebase qemu to 10.0.2, specifically designed for PKU CLab kernel group. You can find the original posts [here](https://airbus-seclab.github.io/qemu_blog/).

Code for this lecture series is available at [CLab QEMU Internals](https://github.com/pkucnc/qemu_internals). All code is developed and tested based on QEMU v10.0.2. If you find any bugs, please feel free to open an issue or submit a pull request.

Example compile command:

```bash
./configure --prefix=~/install/ --target-list=riscv64-softmmu,x86_64-softmmu --disable-docs
make -j$(nproc)
make install
```

# Introduction

This is a series of posts about **QEMU internals**. It won't cover
everything about QEMU, but should help you understand how it works and
foremost how to hack into it for fun and profit.

We won't explain usage and other things that can be found in the
official documentation. The following topics will be addressed:

QEMU Internals:
- [00 Creating a new machine](machine.html)
- [01 Controlling memory regions](regions.html)
- [02 Creating interrupts controller and new devices](devices.html)
- [03 Timers](timers.html)
- [04 Execution loop and accelerators](exec.html)
- [05 Breakpoints handling](brk.html)
- [06 VM running states](runstate.html)
- [07 VM Snapshotting](snapshot.html)

TCG Topics:
- [08.1 TCG IR generation](tcg_ir.html)
- [08.2 TCG Host code generation](tcg_host.html)
- [08.3 TCG Memory Operations](tcg_mem.html)

PCIe Topics:
- [09.1 PCIe overview](pcie.html)
- [09.2 PCIe controller emulation](pcie_controller.html)
- [09.3 PCIe device emulation](pcie_device.html)

The official code and documentation can be found here:

- https://github.com/qemu/qemu
- https://www.qemu.org/documentation/

# Terminology

## Host and target

The host is the plaform and architecture which QEMU is running
on. Usually an x86 machine.

The target is the architecture which is emulated by QEMU. You can
choose at build time which one you want:

```
./configure --target-list=riscv64-softmmu,x86_64-softmmu ...
```

As such, in the source code organisation you will find all supported
architectures in the `target/` directory:

```
(qemu-git) ll target
drwxrwxr-x  2 xxx xxx 4.0K  alpha/
drwxrwxr-x  4 xxx xxx 4.0K  arm/
drwxrwxr-x  2 xxx xxx 4.0K  avr/
drwxrwxr-x  5 xxx xxx 4.0K  hexagon/
drwxrwxr-x  2 xxx xxx 4.0K  hppa/
drwxrwxr-x  7 xxx xxx 4.0K  i386/
drwxrwxr-x  4 xxx xxx 4.0K  loongarch/
drwxrwxr-x  2 xxx xxx 4.0K  m68k/
drwxrwxr-x  2 xxx xxx 4.0K  microblaze/
drwxrwxr-x  4 xxx xxx 4.0K  mips/
drwxrwxr-x  2 xxx xxx 4.0K  openrisc/
drwxrwxr-x  3 xxx xxx 4.0K  ppc/
drwxrwxr-x  5 xxx xxx 4.0K  riscv/
drwxrwxr-x  2 xxx xxx 4.0K  rx/
drwxrwxr-x  4 xxx xxx 4.0K  s390x/
drwxrwxr-x  2 xxx xxx 4.0K  sh4/
drwxrwxr-x  2 xxx xxx 4.0K  sparc/
drwxrwxr-x  2 xxx xxx 4.0K  tricore/
drwxrwxr-x 12 xxx xxx 4.0K  xtensa/
```

The `qemu-system-<target>` binaries are built into their respective `<target>-softmmu` directory:

```
(qemu-git) ls -ld *-softmmu
drwxr-xr-x  9 xxx xxx 4096 i386-softmmu
drwxrwxr-x 11 xxx xxx 4096 ppc-softmmu
drwxr-xr-x  9 xxx xxx 4096 x86_64-softmmu
```


## System and user modes

QEMU is a system emulator. It offers emulation of a lot of
architectures and can be run on a lot of architectures.

It is able to emulate a full system (cpu, devices, kernel and apps)
through the `qemu-system-<target>` command line tool. This is the mode we
will dive into.

It also provides a *userland* emulation mode through the `qemu-<target>`
command line tool.

This allows to directly run `<target>` architecture Linux binaries on
a Linux host. It mainly emulates `<target>` instructions set and
forward system calls to the host Linux kernel. The emulation is only
related to user level cpu instructions, not system ones, no device
nore low level memory handling.

We won't cover qemu user mode in this blog post series.


## Emulation, JIT and virtualization

Initially QEMU was an emulation engine, with a Just-In-Time compiler
(TCG). The TCG is here to dynamically translate `target` instruction
set architecture (ISA) to `host` ISA.

We will later see that in the context of the TCG, the `tcg-target`
becomes the architecture to which the TCG has to generate final
assembly code to run on (which is host ISA). Obvious !

There exists scenario where `target` and `host` architectures are the
same. This is typically the case in classical virtualization
environment (VMware, VirtualBox, ...) when a user wants to run Windows
on Linux for instance. The terminology is usually Host and Guest
(*target*).

Nowadays, QEMU offers virtualization through different
**accelerators**. Virtualization is considered an accelerator because
it prevents unneeded emulation of instructions when host and target
share the same architecture. Only system level (aka
*supervisor/ring0*) instructions might be emulated/intercepted.

Of course, the QEMU virtualization capabilities are tied to the host
OS and architecture. The x86 architecture offers hardware
virtualization extensions (Intel VMX/AMD SVM). But the host operating
system must allow QEMU to take benefit of them.

Under an x86-64 Linux host, we found the following accelerators:

```
$ qemu-system-x86_64 -accel ?
Possible accelerators: kvm, xen, tcg
```

While on an x86-64 MacOS host:

```
$ qemu-system-x86_64 -accel ?
Possible accelerators: tcg, hax, hvf
```

The supported accelerators can be found in
[`qemu_init_vcpu() in qemu v4.2.0`](https://github.com/qemu/qemu/tree/v4.2.0/cpus.c#L2134). QEMU has refactored the following code to make it easier to add new accelerators, but we still take the v4.2.0 code as an example:

```c
void qemu_init_vcpu(CPUState *cpu)
{
...
    if (kvm_enabled()) {
        qemu_kvm_start_vcpu(cpu);
    } else if (hvf_enabled()) {
        qemu_hvf_start_vcpu(cpu);
    } else if (tcg_enabled()) {
        qemu_tcg_init_vcpu(cpu);
    } else if (whpx_enabled()) {
        qemu_whpx_start_vcpu(cpu);
    } else {
        qemu_dummy_start_vcpu(cpu);
    }
...
}
```

To make it short:

- `kvm` is the *Linux Kernel-based Virtual Machine* accelerator;
- `hvf` is the MacOS *Hypervisor.framework* accelerator;
- `whp` is the *Windows Hypervisor Platform* accelerator.

You can take benefit of the speed of x86 hardware virtualization under
the three major operating systems. Notice that the TCG is also
considered an accelerator. We can enter a long debate about
terminology here ...

## QEMU APIs

There exists a lot of APIs in QEMU, some are obsolete and not well
documented. Reading the source code still remains your best
option. There is a good overview
[available](https://habkost.net/posts/2016/11/incomplete-list-of-qemu-apis.html).

The posts series will mainly address QOM, qdev and VMState. The QOM is
the more abstract one. While QEMU is developped in C language, the
developpers chose to implement the QEMU Object Model to provide a
framework for registering user creatable types and instantiating
objects from those types: device, machine, cpu, ... People used to
[OOP](https://en.wikipedia.org/wiki/Object-oriented_programming)
concepts will find their mark in the QOM.

We will briefly illustrate how to make use of it, but won't detail its
underlying implementation. Stay pragmatic !

The interested reader can have a look at
[include/qom/object.h](https://github.com/qemu/qemu/tree/v4.2.0/include/qom/object.h).

# Disclaimer from Airbus

It shall be noted that Airbus does not commit itself on the
exhaustiveness and completeness regarding this blog post series. The
information presented here results from the author knowledge and
understandings as of [QEMU
v4.2.0](https://github.com/qemu/qemu/tree/v4.2.0)

# Disclaimer from CLab

CLab does not commit itself on the exhaustiveness and completeness regarding this blog post series. The information presented here results from the author knowledge and understandings as of [QEMU v10.0.2](https://github.com/qemu/qemu/tree/v10.0.2)