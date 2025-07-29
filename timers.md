# A deep dive into QEMU: a Brief History of Time

Ever wanted to play with general relativity? QEMU is a simulation
environment, guess what? We can control time as seen by the VM!

Some architectures directly provide a clock register inside the
CPU. However, a board usually needs extended time control through
dedicated devices. How would you implement such a device inside QEMU?

## Time in QEMU

### QEMU Clocks

QEMU implements several `clocks` to get informed about time. Obviously
you can still directly use host OS interface to get time information.

Looking at
[`timer.h`](https://github.com/qemu/qemu/blob/v10.0.2/include/qemu/timer.h)
we learn that there exists 4 clock types:
- realtime
- host
- virtual
- virtual_rt

The one that will be of interest for simulating basic timers is
`virtual`. It only runs alongside the VM, so it reflects time reality
in the context of the VM.

QEMU provides a `qemu_clock_xxx` API to control time for related clocks.

```c
int64_t now = qemu_clock_get_ms(QEMU_CLOCK_VIRTUAL);
```

This returns the current time in millisecond for the `virtual`
clock.

### QEMU Timers

QEMU provides a `timer_xxx` API to create, modify, reset, delete
`timers`, for different clocks and granularity (ms, ns). You can
attach timers to specific clocks. The main QEMU execution loop
controls the `virtual` clock and can disable timers when the VM vCPU
is stopped.

The following piece of code creates a `timer` with milliseconds
granularity, that runs only when the VM vCPU runs:

```c
QEMUTimer *user_timer = timer_new_ms(QEMU_CLOCK_VIRTUAL, user_timeout_cb, obj);
int64_t    now        = qemu_clock_get_ms(QEMU_CLOCK_VIRTUAL);

timer_mod(timer, now + duration);

static void user_timeout_cb(void *opaque)
{
  obj_t *obj = (obj_t*)opaque;
...
}
```

When `duration` milliseconds have elapsed in the `virtual clock` time,
the callback function `user_timeout_cb` is called.


## Creating a timer device

As any other device, and following the datasheet of the timer you
would like to simulate, you will have to expose IO memory regions to
reflect device register configuration to QEMU timers setup and raise
IRQs on those timers expiration.

So you will need both device specific hardware representation and QEMU
internal clock model.

### CLabPU tick timer

Under our CLabPU example implementation this may look like the following:

```c
typedef struct clabpu_clock {
    QEMUTimer *qemu_timer;
    uint32_t  *trigger;
    int64_t    restart;
    double     duration;
} clabpu_clock_t;

typedef struct CLabPUTimerState {
    /*< private >*/
    SysBusDevice parent_obj;

    /*< public >*/
    MemoryRegion iomem;
    
    /* Timer registers */
    uint32_t counter;
    uint32_t control;
    uint32_t status;
    uint32_t prescaler;
    
    qemu_irq irq;
    clabpu_clock_t tick;
    uint32_t frequency;     /* Timer base frequency in Hz */
    
} CLabPUTimerState;
```

We have a standard `SysBusDevice` with `iomem` IO memory region and
individual device register fields (counter, control, status, prescaler). 
It also declares a `clabpu_clock` called `tick`.

```c
static void clabpu_init_timer(CLabPUState *clabpu)
{
    DeviceState *dev;
    SysBusDevice *sbd;
    
    dev = qdev_new(TYPE_CLABPU_TIMER);
    sbd = SYS_BUS_DEVICE(dev);

    object_property_set_int(OBJECT(dev), "frequency", 1000000, &error_abort);
    object_property_add_child(OBJECT(clabpu), "timer", OBJECT(dev));
    
    sysbus_realize_and_unref(sbd, &error_fatal);
    sysbus_mmio_map(sbd, 0, clabpu_memmap[CLABPU_TIMER_ADDR].base);
    
    sysbus_connect_irq(sbd, 0,
                       qdev_get_gpio_in(clabpu->intc, CLABPU_IRQ_TIMER));
    
    clabpu->timer = dev;
}
```

We actually setup a device whose any access to `s->iomem` will update
the device registers thanks to the `clabpu_timer_ops`
[`MemoryRegionOps`](https://github.com/qemu/qemu/blob/v10.0.2/include/exec/memory.h#L274). In
the meantime, a nano second `virtual clock` timer is created to call
`tick_expired`.

### Accessing the CLabPU tick timer

Let's say offset `0x00` is a `R/W 32 bits TIME_COUNTER` register for
our imaginary timer device. The counter is decremented at a given
frequency (usually adjustable via a scale register). When it reaches
0, it raises an IRQ.

Eventually an OS driver running on our CLabPU board, and trying to
setup the timer device, will happen to write to this register.

A candidate implementation would be:

```c
static const MemoryRegionOps clabpu_timer_ops = {
    .read = clabpu_timer_read,
    .write = clabpu_timer_write,
    .endianness = DEVICE_LITTLE_ENDIAN,
    ...
};

static void clabpu_timer_write(void *opaque, hwaddr addr, uint64_t data, unsigned size)
{
....
    CLabPUTimerState *s = CLABPU_TIMER(opaque);

    if (addr == CLABPU_TIMER_COUNTER)
        write_counter(s, data);
....
}

static void write_counter(CLabPUTimerState *s, uint32_t new)
{
    if (!(s->control & CLABPU_TIMER_CTRL_ENABLE))
        return;

    if (new == 0)
        tick_expired((void*)s);
    else
        clock_setup(s, &s->tick, new);
}

static void tick_expired(void *opaque)
{
    CLabPUTimerState *s = (CLabPUTimerState *)opaque;
    qemu_irq_raise(s->irq);
}
```

If the driver modifies the device `counter`, we should check for
possible immediate expiration and raise an IRQ. Else we must update
our QEMU internal timer to trigger a call to `tick_expired` at the
expected `virtual` clock time.


### Time dilatation

Interestingly, the `clock_setup` might look like:

```c
static void clock_setup(CLabPUTimerState *s, clabpu_clock_t *clk, uint32_t count)
{
    clk->duration = nsperiod * count;
    clk->restart  = qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL);

    uint64_t expire = clk->restart + (int64_t)floor(clk->duration);
    timer_mod_ns(clk->qemu_timer, expire /* +/- speed factor */);
}
```

We compute the next expiration date in nano seconds based on the new
counter value and the timer frequency (expressed as `nsperiod`). This
period might be computed as follows:

```c
    nsperiod = (1000000000.0 / s->frequency) * prescaler;
```

Notice that we can also induce a *speed factor* effect to the
`virtual` clock.


### Elapsed time

Conversely, whenever a driver reads the device `counter` register,
your code must reflect the elapsed time in the VM and give back an
appropriate value. Something like:

```c
    now          = qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL);
    count        = (now - clk->restart)/nsperiod;
    clk->restart = now;
```

## Note

As we go much further, we will not show the full code of the CLabPU. You can try implementing them by yourself, or see the git commit history of the [qemu-internals](https://github.com/pkucnc/qemu_internals).