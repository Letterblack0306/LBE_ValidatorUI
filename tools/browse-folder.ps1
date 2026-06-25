Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("42F85136-DB7E-439C-85F1-E4075D135FC8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IFileDialog {
    [PreserveSig] int Show(IntPtr hwnd);
    void SetFileTypes(uint c, IntPtr types);
    void SetFileTypeIndex(uint index);
    void GetFileTypeIndex(out uint index);
    void Advise(IntPtr sink, out uint cookie);
    void Unadvise(uint cookie);
    void SetOptions(uint fos);
    void GetOptions(out uint fos);
    void SetDefaultFolder([MarshalAs(UnmanagedType.Interface)] object psi);
    void SetFolder([MarshalAs(UnmanagedType.Interface)] object psi);
    void GetFolder([MarshalAs(UnmanagedType.Interface)] out object ppsi);
    void GetCurrentSelection([MarshalAs(UnmanagedType.Interface)] out object ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void GetResult([MarshalAs(UnmanagedType.Interface)] out object ppsi);
    void AddPlace([MarshalAs(UnmanagedType.Interface)] object psi, int fdap);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string ext);
    void Close(int hr);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr pFilter);
}

[ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IShellItem psi, uint hint, out int piOrder);
}

public static class FolderPicker {
    static readonly Guid CLSID_FileOpenDialog = new Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7");
    const uint FOS_PICKFOLDERS      = 0x00000020;
    const uint FOS_FORCEFILESYSTEM  = 0x00000040;
    const uint FOS_PATHMUSTEXIST    = 0x00000800;
    const uint SIGDN_FILESYSPATH    = 0x80058000;

    public static string Pick(string title) {
        var dialog = (IFileDialog)Activator.CreateInstance(Type.GetTypeFromCLSID(CLSID_FileOpenDialog));
        try {
            dialog.SetOptions(FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
            dialog.SetTitle(title);
            int hr = dialog.Show(IntPtr.Zero);
            if (hr != 0) return null;
            object item;
            dialog.GetResult(out item);
            var si = (IShellItem)item;
            string path;
            si.GetDisplayName(SIGDN_FILESYSPATH, out path);
            return path;
        } finally {
            Marshal.ReleaseComObject(dialog);
        }
    }
}
'@

$result = [FolderPicker]::Pick("Select Project Root Folder")
if ($result) { Write-Output $result }
