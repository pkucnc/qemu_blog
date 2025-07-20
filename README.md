# CLab QEMU Internals

This lecture series is adopted from the [QEMU Internals](https://airbus-seclab.github.io/qemu_blog/) blog posts published by Airbus Security Lab. Compared to the original posts, we changed the target architecture to `riscv64`, rebase qemu to 10.0.2, and removed `TCG` related content.

This is a series of posts about **QEMU internals**. It won't cover
everything about QEMU, but should help you understand how it works and
foremost how to hack into it for fun and profit.

We won't explain usage and other things that can be found in the
official documentation. The following topics will be addressed:

- [Creating a new machine](machine.md)
- [Controlling memory regions](regions.md)
- [Creating a new device](devices.md)
- [Interrupts controller](interrupts.md)
- [Timers](timers.md)
- [PCI controller](pci.md)
- [PCI devices](pci_slave.md)
- [Options](options.md)
- [Execution loop](exec.md)
- [Breakpoints handling](brk.md)
- [VM running states](runstate.md)
- [Snapshots](snapshot.md)

The official code and documentation can be found here:

- https://github.com/qemu/qemu
- https://www.qemu.org/documentation/
