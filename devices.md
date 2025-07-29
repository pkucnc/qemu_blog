# A deep dive into QEMU: adding devices and interrupts

In this post, we will see how to create new devices and interrupt controllers. Other
posts will be dedicated to more complex devices such as PCI controllers.

## The QEMU device tree (abbreviated)

The QEMU monitor offers you different commands to inspect devices for a running instance:

```
$ qemu-system-riscv64 -M virt -s -S -nographic # then press Ctrl-A C to enter the monitor
QEMU 10.0.2 monitor - type 'help' for more information
(qemu) info qom-tree
/machine (virt-machine)
  /fw_cfg (fw_cfg_mem)
    /\x2from@etc\x2facpi\x2frsdp[0] (memory-region)
    /\x2from@etc\x2facpi\x2ftables[0] (memory-region)
    /\x2from@etc\x2ftable-loader[0] (memory-region)
    /fwcfg.ctl[0] (memory-region)
    /fwcfg.data[0] (memory-region)
    /fwcfg.dma[0] (memory-region)
  /peripheral (container)
  /peripheral-anon (container)
  /soc0 (riscv.hart_array)
    /harts[0] (rv64-riscv-cpu)
      /riscv.cpu.rnmi[0] (irq)
      ...
      /unnamed-gpio-in[0] (irq)
      ...
  /unattached (container)
    /device[0] (riscv.aclint.swi)
      /riscv.aclint.swi[0] (memory-region)
    /device[10] (virtio-mmio)
      /virtio-mmio-bus.6 (virtio-mmio-bus)
      /virtio-mmio[0] (memory-region)
    /device[11] (virtio-mmio)
      /virtio-mmio-bus.7 (virtio-mmio-bus)
      /virtio-mmio[0] (memory-region)
    /device[12] (gpex-pcihost)
      /gpex_ioport[0] (memory-region)
      /gpex_ioport_window[0] (memory-region)
      /gpex_mmio[0] (memory-region)
      /gpex_mmio_window[0] (memory-region)
      /gpex_root (gpex-root)
        /bus master container[0] (memory-region)
        /bus master[0] (memory-region)
      /pcie-ecam[0] (memory-region)
      /pcie-mmcfg-mmio[0] (memory-region)
      /pcie-mmio-high[0] (memory-region)
      /pcie-mmio[0] (memory-region)
      /pcie.0 (PCIE)
    /device[13] (platform-bus-device)
      /platform bus[0] (memory-region)
    /device[14] (serial-mm)
      /serial (serial)
      /serial[0] (memory-region)
    /device[15] (goldfish_rtc)
      /goldfish_rtc[0] (memory-region)
    /device[1] (riscv.aclint.mtimer)
      /riscv.aclint.mtimer[0] (memory-region)
    /device[2] (riscv.sifive.plic)
      /riscv.sifive.plic[0] (memory-region)
      /unnamed-gpio-in[0] (irq)
      ...
    /device[3] (riscv.sifive.test)
      /riscv.sifive.test[0] (memory-region)
    /device[4] (virtio-mmio)
      /virtio-mmio-bus.0 (virtio-mmio-bus)
      /virtio-mmio[0] (memory-region)
    /device[5] (virtio-mmio)
      /virtio-mmio-bus.1 (virtio-mmio-bus)
      /virtio-mmio[0] (memory-region)
    /device[6] (virtio-mmio)
      /virtio-mmio-bus.2 (virtio-mmio-bus)
      /virtio-mmio[0] (memory-region)
    /device[7] (virtio-mmio)
      /virtio-mmio-bus.3 (virtio-mmio-bus)
      /virtio-mmio[0] (memory-region)
    /device[8] (virtio-mmio)
      /virtio-mmio-bus.4 (virtio-mmio-bus)
      /virtio-mmio[0] (memory-region)
    /device[9] (virtio-mmio)
      /virtio-mmio-bus.5 (virtio-mmio-bus)
      /virtio-mmio[0] (memory-region)
    /io[0] (memory-region)
    /riscv_virt_board.mrom[0] (memory-region)
    /sysbus (System)
    /system[0] (memory-region)
  /virt.flash0 (cfi.pflash01)
    /virt.flash0[0] (memory-region)
  /virt.flash1 (cfi.pflash01)
    /virt.flash1[0] (memory-region)
```

A lot of things there. From the machine itself, to the CPU objects (RISC-V hart array), interrupt controllers (ACLINT software interrupts, ACLINT timer, SIFIVE PLIC), MMIO devices (virtio-mmio), PCIe host controller (gpex-pcihost), PCIe bus, system bus, serial device (serial-mm), and RTC (goldfish_rtc).

All of them are QEMU Objects. You can also use the `info qtree`
command to have a more detailled view.

## QEMU Monitor commands

Notice that the monitor commands are implemented through the QMP API
and are referenced as `hmp commands` in the QEMU source code. All the available
commands are located at
[`hmp-commands-info.hx`](https://github.com/qemu/qemu/blob/v10.0.2/hmp-commands-info.hx)

They look like the following:

```c
{
    .name       = "mtree",
    .args_type  = "flatview:-f,dispatch_tree:-d,owner:-o,disabled:-D",
    .params     = "[-f][-d][-o][-D]",
    .help       = "show memory tree (-f: dump flat view for address spaces;"
                    "-d: dump dispatch tree, valid with -f only);"
                    "-o: dump region owners/parents;"
                    "-D: dump disabled regions",
    .cmd        = hmp_info_mtree,
},
```

Where
[`hmp_info_mtree()`](https://github.com/qemu/qemu/blob/v10.0.2/monitor/hmp-cmds.c#L412)
is the handler.

## A device is a QObject

QEMU uses an object-oriented model called QOM (QEMU Object Model) to represent all devices. Since C doesn't have native OOP support, QEMU implements its own object system. Every device in QEMU inherits from `DeviceState`(which inherits from `QObject`). You can describe a device by defining its type, state, and class. The type is defined using the `OBJECT_DECLARE_SIMPLE_TYPE` macro, which registers the type with QEMU's type system.

We list code for [`TypeInfo`](https://github.com/qemu/qemu/tree/v10.0.2/include/qom/object.h#L475),
[`DeviceClass`](https://github.com/qemu/qemu/tree/v10.0.2/include/hw/qdev-core.h#L114)
and
[`DeviceState`](https://github.com/qemu/qemu/tree/v10.0.2/include/hw/qdev-core.h#L226) here, you can
check them for more details. A basic example of a device implementation in QEMU looks like this:

```c
#define TYPE_MY_DEVICE "my-device"
OBJECT_DECLARE_SIMPLE_TYPE(MyDeviceState, MY_DEVICE)

// Device state structure
struct MyDeviceState {
    /*< private >*/
    SysBusDevice parent_obj;  // Inherit from SysBusDevice
    
    /*< public >*/
    // Device-specific fields go here
};

// TypeInfo structure
static const TypeInfo my_device_info = {
    .name          = TYPE_MY_DEVICE,
    .parent        = TYPE_SYS_BUS_DEVICE,
    .instance_size = sizeof(MyDeviceState),
    .instance_init = my_device_init,
    .class_init    = my_device_class_init,
};
```

## IRQs and interrupt controllers

IRQ (Interrupt Request) is a abstraction of signal propagation between devices. It connects a interrupt source, such as a device, to an interrupt sink, such as an interrupt controller or a CPU. When a device needs to signal an event, it raises an IRQ, which is then handled by the interrupt controller or CPU.

In QEMU, IRQs are represented by the [`qemu_irq`](https://github.com/qemu/qemu/blob/v10.0.2/include/hw/irq.h), the are defined as:

```c
#define TYPE_IRQ "irq"
OBJECT_DECLARE_SIMPLE_TYPE(IRQState, IRQ)

struct IRQState {
    Object parent_obj;

    qemu_irq_handler handler;
    void *opaque;
    int n;
};
```

It's a simple object with a number, a callback and its avaible generic
argument (usually the *interrupt controller* device whose handler is
being called). And if you look at
[`qdev_init_gpio_in_named_with_opaque`](https://github.com/qemu/qemu/blob/v10.0.2/hw/core/gpio.c#L43):

```c
void qdev_init_gpio_in_named_with_opaque(DeviceState *dev,
                                         qemu_irq_handler handler,
                                         void *opaque,
                                         const char *name, int n)
{
    ...
    gpio_list->in = qemu_extend_irqs(gpio_list->in, gpio_list->num_in, handler,
                                     opaque, n);
    ...
}

qemu_irq *qemu_extend_irqs(qemu_irq *old, int n_old, qemu_irq_handler handler,
                           void *opaque, int n)
{
    qemu_irq *s;
    int i;
    ...
    for (i = n_old; i < n + n_old; i++) {
        s[i] = qemu_allocate_irq(handler, opaque, i);
    }
    return s;
}

qemu_irq qemu_allocate_irq(qemu_irq_handler handler, void *opaque, int n)
{
    IRQState *irq = IRQ(object_new(TYPE_IRQ));
    init_irq_fields(irq, handler, opaque, n);
    return irq;
}
```

And whenever an IRQ is raised or lowered:

```c
static inline void qemu_irq_raise(qemu_irq irq) { qemu_set_irq(irq, 1); }
static inline void qemu_irq_lower(qemu_irq irq) { qemu_set_irq(irq, 0); }

void qemu_set_irq(qemu_irq irq, int level)
{
    if (!irq)
        return;

    irq->handler(irq->opaque, irq->n, level);
}
```

## Creating and Instantiating Our Device: clabpu_intc

Let's create a simple interrupt controller device called `clabpu_intc`. This device will handle interrupts from other devices and provide a way to raise and lower IRQs. We implement it in `hw/intc/clabpu_intc.c` and `include/hw/intc/clabpu_intc.h`, so you need to edit the `meson.build` file to include these files in the build process.

First, we define the device type and its state:

```c
#define TYPE_CLABPU_INTC "clabpu-intc"
OBJECT_DECLARE_SIMPLE_TYPE(CLabPUIntcState, CLABPU_INTC)

struct CLabPUIntcState {
    SysBusDevice parent_obj;
    MemoryRegion iomem;
    uint32_t pending;
    uint32_t enable;
    uint8_t priority[CLABPU_INTC_NUM_SOURCES];
    qemu_irq cpu_irq;
};
```
Then, we implement the device's initialization and class initialization functions. We have learned a lot about these functions in the previous posts, so we will not go into details here. The `clabpu_intc_init` function initializes the device's memory region and sets up the input GPIO lines (from devices) and output IRQ lines (to the CPU):

```c
static void clabpu_intc_init(Object *obj)
{
    CLabPUIntcState *s = CLABPU_INTC(obj);
    SysBusDevice *sbd = SYS_BUS_DEVICE(obj);
    DeviceState *dev = DEVICE(obj);

    /* Initialize memory region */
    memory_region_init_io(&s->iomem, obj, &clabpu_intc_ops, s,
                          "clabpu-intc", CLABPU_INTC_SIZE);
    sysbus_init_mmio(sbd, &s->iomem);

    /* Initialize input GPIO lines (from devices) */
    qdev_init_gpio_in(dev, clabpu_intc_set_irq, CLABPU_INTC_NUM_SOURCES);

    /* Initialize output IRQ lines, it will be connected to the CPU */
    sysbus_init_irq(sbd, &s->cpu_irq); 
}

static void clabpu_intc_class_init(ObjectClass *klass, void *data)
{
    DeviceClass *dc = DEVICE_CLASS(klass);

    dc->desc = "CLab Processor Unit Interrupt Controller";
    dc->realize = clabpu_intc_realize;
    dc->legacy_reset = clabpu_intc_reset; /* warn: depreciated */
    dc->vmsd = &vmstate_clabpu_intc;
    set_bit(DEVICE_CATEGORY_MISC, dc->categories);
}

static const TypeInfo clabpu_intc_info = {
    .name          = TYPE_CLABPU_INTC,
    .parent        = TYPE_SYS_BUS_DEVICE,
    .instance_size = sizeof(CLabPUIntcState),
    .instance_init = clabpu_intc_init,
    .class_init    = clabpu_intc_class_init,
};

static void clabpu_intc_register_types(void)
{
    type_register_static(&clabpu_intc_info);
}
```

### Preparing the receiving IRQ lines

The fundamental element is that we register 32 IRQ input lines, set their handler logic. Upon IRQ events (raised or lowered), the handler will be called with the IRQ number and level. You can find `clabpu_intc_update` and more code in the
[`clabpu_intc.c`](http://github.com/pkucnc/qemu_internals/hw/riscv/clabpu_intc.c) file, we will not go into details here for brevity.

```c
static void clabpu_intc_set_irq(void *opaque, int irq, int level)
{
    CLabPUIntcState *s = CLABPU_INTC(opaque);

    if (irq >= CLABPU_INTC_NUM_SOURCES) {
        qemu_log_mask(LOG_GUEST_ERROR,
                      "clabpu_intc: invalid irq %d\n", irq);
        return;
    }

    if (level) {
        s->pending |= (1 << irq);
    } else {
        s->pending &= ~(1 << irq);
    }

    clabpu_intc_update(s);
}
```

### Mapping device IO memory region

Also, interrupt controllers support `MemoryRegionOps` just like any other device. We define the memory region operations for our interrupt controller. You can find the implementation of `clabpu_intc_read` and `clabpu_intc_write` in the
[`clabpu_intc.c`](http://github.com/pkucnc/qemu_internals/hw/riscv/clabpu_intc.c) file, which is not very interesting for this post.

```c

static const MemoryRegionOps clabpu_intc_ops = {
    .read = clabpu_intc_read,
    .write = clabpu_intc_write,
    .endianness = DEVICE_LITTLE_ENDIAN,
    .valid = {
        .min_access_size = 1,
        .max_access_size = 4,
    },
};
```
### Connect interrupt controller to CPU

Finally, we need to connect the interrupt controller to the CPU. This is done by call `sysbus_realize_and_unref` to activate the device and map its memory region. We also connect the CPU's IRQ lines to the interrupt controller's IRQ lines.

```c
static void clabpu_init_intc(CLabPUState *clabpu, MachineState *machine)
{
    DeviceState *dev;
    SysBusDevice *sbd;
    
    dev = qdev_new(TYPE_CLABPU_INTC);
    sbd = SYS_BUS_DEVICE(dev);

    // append intc to the machine's device tree
    object_property_add_child(OBJECT(machine), "intc", OBJECT(dev));
    
    sysbus_realize_and_unref(sbd, &error_fatal);
    sysbus_mmio_map(sbd, 0, clabpu_memmap[CLABPU_INTC_ADDR].base);
    
    // we only support a single CPU for simplicity
    RISCVCPU *cpu = &clabpu->soc.harts[0];
    sysbus_connect_irq(sbd, 0, 
                      qdev_get_gpio_in(DEVICE(cpu), IRQ_M_EXT));
    
    qemu_log("Connected INTC to single CPU\n");
    
    clabpu->intc = dev;
}
```

## Yet another device: clabpu_edc

We can create another device, the `clabpu_edc`, which is a simple device that can raise and lower IRQs. It will be used to demonstrate how to interact with the interrupt controller. These code are placed in `hw/riscv/clabpu_edc.c` and `include/hw/riscv/clabpu_edc.h`.

```c
#define TYPE_CLABPU_EDC "clabpu-edc"
OBJECT_DECLARE_SIMPLE_TYPE(CLabPUEdcState, CLABPU_EDC)

struct CLabPUEdcState {
    /*< private >*/
    SysBusDevice parent_obj;

    /*< public >*/
    MemoryRegion reg1;
    MemoryRegion err;
    
    /* Internal state */
    ...
    
    /* IRQ line */
    qemu_irq irq;
};
```

### Connecting IRQ lines

At board level, we need to initialize the `clabpu_edc` device and connect it to `clabpu_intc`. This is done by `clabpu_init_edc()` function which will be called by `clabpu_init_dev()`, after `clabpu_init_intc()`. Full code is available in the
[`clabpu_edc.c`](https://github.com/pkucnc/qemu_internals/hw/riscv/clabpu_edc.c) file.

```c
static void clabpu_init_edc(CLabPUState *clabpu)
{
    DeviceState *dev;
    SysBusDevice *sbd;
    
    /* Create EDC device */
    dev = qdev_new(TYPE_CLABPU_EDC);
    sbd = SYS_BUS_DEVICE(dev);

    /* Attach EDC to the CLabPU device tree */
    object_property_add_child(OBJECT(clabpu), "edc", OBJECT(dev));
    
    sysbus_realize_and_unref(sbd, &error_fatal);
    sysbus_mmio_map(sbd, 0, CLABPU_MMAP_EDC_REG);
    
    /* Connect EDC interrupt to interrupt controller */
    sysbus_connect_irq(sbd, 0,
                       qdev_get_gpio_in(clabpu->intc, CLABPU_IRQ_EDC_ERR));
    
    clabpu->edc = dev;
}
```

Then, edc can update and raise its IRQ line by calling:

```c
static void clabpu_edc_update_irq(CLabPUEdcState *s)
{
    bool irq_level = (s->int_status & s->int_enable) != 0;
    qemu_set_irq(s->irq, irq_level);
}
```

## Validation

You'll be able to see the devices in the QEMU monitor:

```
$ qemu-system-riscv64 -M clabpu -cpu thead-c906 -nographic
(qemu) info qom-tree
/machine (clabpu-machine)
...
  /edc (clabpu-edc)
    /clabpu-edc-err[0] (memory-region)
    /clabpu-edc-reg1[0] (memory-region)
  /intc (clabpu-intc)
    /clabpu-intc[0] (memory-region)
    /unnamed-gpio-in[0] (irq)
...
```
## Conclusion and key takeaways

- Devices in QEMU are implemented as QObjects, inheriting from `DeviceState`.
- Interrupt controllers are devices that handle IRQs from other devices and provide a way to raise and lower IRQs.
- IRQs are represented by `qemu_irq` objects, which have a handler, an opaque pointer, and a number.
- IRQs and MMAP regions are important for device communication and interaction.
