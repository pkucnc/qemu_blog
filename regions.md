---
layout: default
title: 02 Qemu memory regions
---

# A deep dive into QEMU: memory regions

In this post we'll have a glance at high level memory organisation in
QEMU: memory regions (MR).

We won't cover address spaces, because we usually manage memory
regions directly. However, have a look at
[docs/devel/memory, recommanded](https://github.com/qemu/qemu/tree/v10.0.2/docs/devel/memory.rst)
and the code
([include/exec/memory.h](https://github.com/qemu/qemu/blob/v10.0.2/include/exec/memory.h)) for more details.

An high level external presentation of memory organisation is
available
[there](http://blog.vmsplice.net/2016/01/qemu-internals-how-guest-physical-ram.html). You
will also find a very interesting internal documentation at
[docs/devel/loads-stores](https://github.com/qemu/qemu/blob/v10.0.2/docs/devel/loads-stores.rst). This
is an enumeration of the available QEMU APIs for accessing memory.

When you want to play with memory regions in QEMU, you can either:

- get a direct pointer to the host buffer backing your VM memory
  region
- implement read/write callback functions to intercept every access (usually IO
  memory)
- use QEMU
  [`cpu_physical_memory_rw()`](https://github.com/qemu/qemu/tree/v10.0.2/system/physmem.c#L3167) to safely access the region

In the blog post dedicated to the TCG, we will exactly see how
translated instructions access VM memory and how we can intercept at
this level.


## Looking at the memory tree (abbreviated)

Below is the tree of available memory regions once a `SiFive HiFive Unleashed`
board is ready. As you can see, memory regions can contain other
memory regions (called `subregions`). This a clean way to organize
memory. Each memory region has its own properties and is attached to a
kind of view called the `address space`.

```
$ qemu-system-riscv64 -M sifive_u -s -S -nographic # then press Ctrl-A C to enter the monitor
QEMU 10.0.2 monitor - type 'help' for more information
(qemu) info mtree
address-space: cpu-memory-0
address-space: cpu-memory-1
address-space: dma
address-space: memory
  0000000000000000-ffffffffffffffff (prio 0, i/o): system
    0000000000001000-000000000000ffff (prio 0, rom): riscv.sifive.u.mrom
    0000000002000000-0000000002003fff (prio 0, i/o): riscv.aclint.swi
    0000000002004000-000000000200bfff (prio 0, i/o): riscv.aclint.mtimer
    0000000002010000-0000000002010fff (prio -1000, i/o): riscv.sifive.u.l2cc
    0000000003000000-00000000030fffff (prio 0, i/o): sifive.pdma
    0000000008000000-0000000009ffffff (prio 0, ram): riscv.sifive.u.l2lim
    000000000c000000-000000000fffffff (prio 0, i/o): riscv.sifive.plic
    0000000010000000-0000000010000fff (prio 0, i/o): riscv.sifive.u.prci
    0000000010010000-000000001001001f (prio 0, i/o): riscv.sifive.uart
    0000000010011000-000000001001101f (prio 0, i/o): riscv.sifive.uart
    0000000010020000-00000000100200ff (prio 0, i/o): sifive-pwm
    0000000010021000-00000000100210ff (prio 0, i/o): sifive-pwm
    0000000010040000-0000000010040fff (prio 0, i/o): sifive.spi
    0000000010050000-0000000010050fff (prio 0, i/o): sifive.spi
    0000000010060000-00000000100600ff (prio 0, i/o): sifive_soc.gpio
    0000000010070000-0000000010070fff (prio 0, i/o): riscv.sifive.u.otp
    0000000010090000-00000000100907ff (prio 0, i/o): enet
    00000000100a0000-00000000100a0fff (prio -1000, i/o): riscv.sifive.u.gem-mgmt
    00000000100b0000-00000000100bffff (prio -1000, i/o): riscv.sifive.u.dmc
    0000000020000000-000000002fffffff (prio 0, ram): riscv.sifive.u.flash0
    0000000080000000-0000000087ffffff (prio 0, ram): riscv.sifive.u.ram

address-space: I/O
  0000000000000000-000000000000ffff (prio 0, i/o): io

```

Default memory regions and address spaces are created by QEMU. The
most important is the `system memory region` which is created by
[`memory_map_init()`](https://github.com/qemu/qemu/tree/v10.0.2/system/physmem.c#L2789)
from
[`cpu_exec_init_all()`](https://github.com/qemu/qemu/tree/v10.0.2/system/physmem.c#L3291).

It can be seen as the top level one, and usually `subregions` are
added to the `system memory region`.


## Allocating system memory

This might be one of the most desired things when creating a new
machine : get RAM and load a firmware. The correct function to invoke
is
[`memory_region_add_subregion()`](https://github.com/qemu/qemu/blob/v10.0.2/include/exec/memory.h#L2313).

If we look at some other board implementations, for instance the
[`MIPS malta`](https://github.com/qemu/qemu/blob/v10.0.2/hw/mips/malta.c#L1124)

```c
void mips_malta_init(MachineState *machine)
{
...
    MemoryRegion *system_memory = get_system_memory();
    /* register RAM at high address where it is undisturbed by IO */
    memory_region_add_subregion(system_memory, 0x80000000, machine->ram);

...
}
```

A new memory region for the RAM is created and directly added as a
`subregion` of the `system memory region`. From that point, accessing
physical addresses `0x80000000 - 0x80000000+machine->ram_size`
will access the RAM.

The QEMU memory API allows you to create memory regions backed by file
descriptors, already allocated host buffers and callbacks as we will
see for IOs.

## IO memory regions

Getting back to our simple MIPS board example: (the following code is simplified)

```c
void mips_malta_init(MachineState *machine)
{
...
    MemoryRegion *iomem = g_new(MemoryRegion, 1);

    memory_region_init_io(iomem, NULL, &malta_fpga_ops, s, "malta-fpga", 0x100000);
    memory_region_add_subregion(system_memory, FPGA_ADDRESS, iomem);
}
```

A new memory region `iomem` is created with
[`memory_region_init_io()`](https://github.com/qemu/qemu/blob/v10.0.2/memory.c#L1568)
and also added as a `subregion` of the `system memory`. This region is
not of RAM but IO type and has a special
[`MemoryRegionOps`](https://github.com/qemu/qemu/blob/v10.0.2/include/exec/memory.h#L274)
argument.

```c
static const MemoryRegionOps malta_fpga_ops = {
    .read = malta_fpga_read,
    .write = malta_fpga_write,
    .endianness = DEVICE_NATIVE_ENDIAN,
};

static uint64_t malta_fpga_read(void *opaque, hwaddr addr,
                                unsigned size)
{
    MaltaFPGAState *s = opaque;
    uint32_t val = 0;
    uint32_t saddr;

    saddr = (addr & 0xfffff);

    /* SWITCH Register */
    switch (saddr) {
      case 0x00200:
        val = 0x00000000;
        break;
    }
...
    return val;
}

static void malta_fpga_write(void *opaque, hwaddr addr,
                             uint64_t val, unsigned size)
{
  MaltaFPGAState *s = opaque;
    uint32_t saddr;

    saddr = (addr & 0xfffff);

    switch (saddr) {
      case 0x00500:
        if (val == 0x42) {
            qemu_system_reset_request(SHUTDOWN_CAUSE_GUEST_RESET);
        }
        break;
      ...
    }
    return;
}
```

IO memory regions expose devices memory. They usually need special
interpretation during read/write accesses to simulate the expected
device behavior. Using `MemoryRegionOps` callback helps you implement
device operations.

In the previous example, the `iomem` region is mapped at `FPGA_ADDRESS`, which is `0x1f000000ULL`,  to `FPGA_ADDRESS+0x100000`. Whenever the VM accesses this memory range, the
read/write callbacks will be called. The `addr` argument is an offset
from the beginning of the related memory region.

So doing something like `writeq(0x42, 0x1f000500)` will call `malta_fpga_write()`, and then triggers a system reset.


## Init memory for CLabPU Machine

CLabPU has a DRAM memory region, which should be initialized. Add the following code:
```c
static const MemMapEntry clabpu_memmap[] = {
    [CLABPU_MROM] =     {     0x1000,     0xf000 },
    [CLABPU_HTIF] =     {  0x1000000,     0x1000 },
    [CLABPU_CLINT] =    {  0x2000000,    0x10000 },
    [CLABPU_DRAM] =     { 0x80000000,        0x0 },
};

static void clabpu_init_mem(CLabPUState *clabpu, MachineState *machine)
{
    MemoryRegion *system_memory = get_system_memory();
    MemoryRegion *mask_rom = g_new(MemoryRegion, 1);

    /* register system main memory */
    memory_region_add_subregion(system_memory, memmap[CLABPU_DRAM].base,
        machine->ram);
    /* boot rom */
    memory_region_init_rom(mask_rom, NULL, "riscv.clabpu.mrom",
                           memmap[CLABPU_MROM].size, &error_fatal);
    memory_region_add_subregion(system_memory, memmap[CLABPU_MROM].base, mask_rom);
}
```

Don't forget to call `clabpu_init_mem()` in the `clabpu_init()` function.