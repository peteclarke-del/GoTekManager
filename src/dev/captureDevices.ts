/**
 * Invented storage devices, shown in place of the real ones while the help
 * screenshots are being captured.
 *
 * Everything else in a capture is genuine: the fixture library is really
 * scanned, the destination folder really read, and the screens really clicked
 * through. Devices are the exception, and have to be, because the devices
 * screen names the hardware it can see. A screenshot taken on a developer's
 * machine would otherwise ship that machine's disk models and the tails of its
 * serial numbers into the repository and the in-app help, where they would stay
 * for as long as the image does.
 *
 * Inventing them also makes the picture the same every time, so a screen that
 * has genuinely changed is the only reason for the image to change, and it can
 * show the two routes onto a stick side by side: one drive already formatted
 * for a GoTek and mounted, and one that would have to be formatted first.
 *
 * Reached only through a dynamic import in {@link physicalDevices}, guarded by
 * a condition that is statically false in a production build, so this module is
 * left out of a packaged application altogether.
 */

import type { PhysicalDevice } from '../domain/types'

const GIGABYTE = 1000 * 1000 * 1000

/**
 * Three drives and the machine's own disk.
 *
 * The system disk is there because the screen always lists it and marks it
 * protected, and a screenshot that left it out would suggest the application
 * had not noticed it.
 */
export const CAPTURE_DEVICES: PhysicalDevice[] = [
  {
    node: '/dev/sdb',
    name: 'Generic USB Flash Drive',
    vendor: 'Generic',
    model: 'USB Flash Drive',
    serial: 'AA00000000000001',
    sizeBytes: 8 * GIGABYTE,
    removable: true,
    transport: 'usb',
    system: false,
    partitions: [
      {
        node: '/dev/sdb1',
        sizeBytes: 8 * GIGABYTE - 4 * 1024 * 1024,
        filesystem: 'vfat',
        label: 'GOTEK',
        uuid: 'A1B2-C3D4',
        mountPoints: ['/media/gotek/GOTEK'],
      },
    ],
  },
  {
    node: '/dev/sdc',
    name: 'Generic USB Stick',
    vendor: 'Generic',
    model: 'USB Stick',
    serial: 'AA00000000000002',
    sizeBytes: 4 * GIGABYTE,
    removable: true,
    transport: 'usb',
    system: false,
    partitions: [],
  },
  {
    node: '/dev/sdd',
    name: 'Generic Card Reader',
    vendor: 'Generic',
    model: 'Card Reader',
    serial: 'AA00000000000003',
    sizeBytes: 32 * GIGABYTE,
    removable: true,
    transport: 'usb',
    system: false,
    partitions: [
      {
        node: '/dev/sdd1',
        sizeBytes: 32 * GIGABYTE - 4 * 1024 * 1024,
        filesystem: 'exfat',
        label: 'PHOTOS',
        uuid: 'E5F6-7890',
        mountPoints: ['/media/gotek/PHOTOS'],
      },
    ],
  },
  {
    node: '/dev/nvme0n1',
    name: 'Generic Internal SSD',
    vendor: 'Generic',
    model: 'Internal SSD',
    serial: 'AA00000000000004',
    sizeBytes: 512 * GIGABYTE,
    removable: false,
    transport: 'nvme',
    system: true,
    partitions: [
      {
        node: '/dev/nvme0n1p1',
        sizeBytes: 512 * 1024 * 1024,
        filesystem: 'vfat',
        label: 'EFI',
        mountPoints: ['/boot/efi'],
      },
      {
        node: '/dev/nvme0n1p2',
        sizeBytes: 511 * GIGABYTE,
        filesystem: 'ext4',
        mountPoints: ['/'],
      },
    ],
  },
]
