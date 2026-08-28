require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'ZiptvNativeVideo'
  s.version = package['version']
  s.summary = package['description']
  s.license = 'MIT'
  s.homepage = 'https://github.com/kxng1080xx/ZIPTVPRO'
  s.author = 'Leon Goulbourne'
  s.source = { :git => 'https://github.com/kxng1080xx/ZIPTVPRO.git', :tag => s.version.to_s }
  s.source_files = 'ios/Sources/**/*.{swift,h,m}'
  s.ios.deployment_target = '14.0'
  s.dependency 'Capacitor'
  # Same VLC engine line as the Android build (org.videolan.android:libvlc-all:3.6.5).
  s.dependency 'MobileVLCKit', '~> 3.6.0'
  s.swift_version = '5.1'
end
